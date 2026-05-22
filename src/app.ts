/**
 * HTTP API (Hono) + the gated demo UI.
 *
 * Public:
 *   GET  /                       -> the demo UI (single self-contained HTML page)
 *   POST /auth     { code }      -> verify access code, set signed session cookie
 *   POST /logout                 -> clear the session cookie
 *   GET  /me                     -> 200 if a valid session cookie is present
 *   GET  /healthz                -> liveness
 *
 * Gated (require a valid session cookie — `requireSession` middleware):
 *   POST /extract  { sourceUrl, prefix, files?, destination, byo? }
 *                                -> { jobId, status }
 *   POST /validate-destination { destination } -> { valid, reason? }
 *   GET  /jobs/:id               -> JobReport
 *   GET  /jobs/:id/ws            -> WebSocket upgrade (forwarded to the DO)
 *   GET  /jobs/:id/files         -> list extracted objects under the job prefix
 *   GET  /jobs/:id/files/:name   -> stream one extracted object back
 *
 * The pre-flight on `/extract` reads the ZIP index and validates requested files
 * (cheap — tail + central directory only) before a job is created, so a bad
 * request fails with a clear status BEFORE a DO is spun up.
 */

import { Hono } from 'hono';
import { readIndex } from './extract';
import { makeRuntime, runSafe, toResponse, type Services } from './effect/runtime';
import { EntryNotFoundError, type AppError } from './effect/errors';
import {
  adminCookie,
  clearAdminCookie,
  clearSessionCookie,
  hasValidSession,
  requireAdmin,
  requireSession,
  sessionCode,
  sessionCookie,
  ADMIN_SUBJECT,
  type AuthEnv,
} from './auth/middleware';
import { DEFAULT_SESSION_TTL_MS, signSession, timingSafeEqual } from './auth/session';
import { EVENT_TYPES } from './registry/codes';
import { REGISTRY_NAME, type Registry } from './registry/registry';
import { parseByoConfig, validateDestination, type ByoConfig } from './destination';
import { renderDemoPage } from './ui';
import { renderAdminPage } from './admin-ui';
import { SAMPLE_PRESETS } from './samples';
import { Effect } from 'effect';
import type { Destination, ExtractJob } from './job';
import type { ZipEntry } from './zip';

export interface Env extends AuthEnv {
  EXTRACT_JOB: DurableObjectNamespace<ExtractJob>;
  REGISTRY: DurableObjectNamespace<Registry>;
  OUTPUT: R2Bucket;
  EXTRACT_TTL_HOURS?: string;
}

/** Resolve the singleton Registry stub (always addressed by the same name). */
function registry(env: Env): DurableObjectStub<Registry> {
  return env.REGISTRY.getByName(REGISTRY_NAME);
}

const encoder = new TextEncoder();

interface ExtractBody {
  sourceUrl?: unknown;
  prefix?: unknown;
  files?: unknown;
  destination?: unknown;
  byo?: unknown;
}

export function createApp() {
  const app = new Hono<{ Bindings: Env }>();

  // ---- public ----

  app.get('/', (c) => c.html(renderDemoPage()));

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.post('/auth', async (c) => {
    if (!c.env.SESSION_SECRET) {
      return c.json(
        { error: { tag: 'Unconfigured', message: 'SESSION_SECRET is not configured' } },
        500,
      );
    }
    const body = await readJson(c.req.raw);
    const code =
      body && typeof (body as { code?: unknown }).code === 'string'
        ? (body as { code: string }).code.trim()
        : '';

    // The Registry DO is the source of truth — validate against it (not a static
    // secret). On success the session `sub` IS the code, so all downstream
    // activity attributes to it.
    const result = await registry(c.env).validateCode(code);
    if (!result.ok) {
      return c.json({ error: { tag: 'Unauthorized', message: 'Invalid access code' } }, 401);
    }
    await registry(c.env).recordEvent(code, EVENT_TYPES.sessionStart, {});

    const token = await signSession(c.env.SESSION_SECRET, { sub: code });
    c.header('Set-Cookie', sessionCookie(token, Math.floor(DEFAULT_SESSION_TTL_MS / 1000)));
    return c.json({ ok: true });
  });

  app.post('/logout', (c) => {
    c.header('Set-Cookie', clearSessionCookie());
    return c.json({ ok: true });
  });

  app.get('/me', async (c) => {
    const ok = await hasValidSession(c.req.raw, c.env.SESSION_SECRET);
    return ok ? c.json({ ok: true }) : c.json({ error: { tag: 'Unauthorized' } }, 401);
  });

  // ---- admin ----

  // The admin panel HTML. Public route (gated client-side by the key form);
  // every DATA route below is server-gated by `requireAdmin`.
  app.get('/admin', (c) => c.html(renderAdminPage()));

  // Exchange the ADMIN_KEY for a separate admin session cookie. Constant-time
  // compare so the time taken doesn't leak how much of the key matched.
  app.post('/admin/auth', async (c) => {
    if (!c.env.SESSION_SECRET) {
      return c.json(
        { error: { tag: 'Unconfigured', message: 'SESSION_SECRET is not configured' } },
        500,
      );
    }
    if (!c.env.ADMIN_KEY) {
      return c.json(
        { error: { tag: 'Unconfigured', message: 'ADMIN_KEY is not configured' } },
        500,
      );
    }
    const body = await readJson(c.req.raw);
    const key =
      body && typeof (body as { key?: unknown }).key === 'string'
        ? (body as { key: string }).key
        : '';
    if (!timingSafeEqual(encoder.encode(key), encoder.encode(c.env.ADMIN_KEY))) {
      return c.json({ error: { tag: 'Unauthorized', message: 'Invalid admin key' } }, 401);
    }
    const token = await signSession(c.env.SESSION_SECRET, { sub: ADMIN_SUBJECT });
    c.header('Set-Cookie', adminCookie(token, Math.floor(DEFAULT_SESSION_TTL_MS / 1000)));
    return c.json({ ok: true });
  });

  app.post('/admin/logout', (c) => {
    c.header('Set-Cookie', clearAdminCookie());
    return c.json({ ok: true });
  });

  app.get('/admin/codes', requireAdmin(), async (c) => {
    const codes = await registry(c.env).listCodes();
    return c.json({ codes });
  });

  app.post('/admin/codes', requireAdmin(), async (c) => {
    const body = await readJson(c.req.raw);
    const label =
      body && typeof (body as { label?: unknown }).label === 'string'
        ? (body as { label: string }).label
        : '';
    const created = await registry(c.env).createCode(label);
    return c.json(created, 201);
  });

  app.post('/admin/codes/:code/revoke', requireAdmin(), async (c) => {
    const code = c.req.param('code');
    const result = await registry(c.env).revokeCode(code);
    if (!result.ok) {
      return c.json({ error: { tag: 'CodeNotFound', message: `No code "${code}"` } }, 404);
    }
    return c.json({ ok: true });
  });

  app.get('/admin/codes/:code/timeline', requireAdmin(), async (c) => {
    const code = c.req.param('code');
    const events = await registry(c.env).codeTimeline(code);
    return c.json({ code, events });
  });

  // ---- gated ----

  app.post('/extract', requireSession(), async (c) => {
    const body = await readJson(c.req.raw);
    const parsed = parseExtractBody(body);
    if (!parsed.ok) {
      return c.json({ error: { tag: 'BadRequest', message: parsed.reason } }, 400);
    }
    const { sourceUrl, prefix, files, destination, byo } = parsed.value;

    // Pre-flight: read the index and validate requested files exist. Cheap —
    // only the tail + central directory are fetched, never the file bodies.
    const rt = makeRuntime(sourceUrl, c.env.OUTPUT);
    try {
      const indexResult = await runSafe(rt, readIndex().pipe(validateRequested(files)));
      if (!indexResult.ok) return toResponse(indexResult.error);
    } finally {
      await rt.dispose();
    }

    // Attribute the job to the code that started this session, and label the
    // source as a known sample id or the generic "url". Both flow into the DO so
    // it can record job_started / job_completed events against the code.
    const code = await sessionCode(c.req.raw, c.env.SESSION_SECRET);
    const sourceLabel = labelForSource(sourceUrl);

    const jobId = crypto.randomUUID();
    const stub = c.env.EXTRACT_JOB.getByName(jobId);
    const { status } = await stub.start({
      id: jobId,
      sourceUrl,
      prefix,
      files,
      destination,
      byo,
      code: code ?? undefined,
      sourceLabel,
    });

    return c.json({ jobId, status }, 202);
  });

  app.post('/validate-destination', requireSession(), async (c) => {
    const body = await readJson(c.req.raw);
    const raw =
      body && typeof body === 'object' ? (body as { destination?: unknown }).destination : null;
    const parsed = parseByoConfig(raw);
    if (!parsed.ok) {
      return c.json({ valid: false, reason: parsed.reason }, 400);
    }
    const result = await validateDestination(parsed.value);
    return result.ok
      ? c.json({ valid: true })
      : c.json({ valid: false, reason: result.reason }, 200);
  });

  app.get('/jobs/:id', requireSession(), async (c) => {
    const id = c.req.param('id');
    const stub = c.env.EXTRACT_JOB.getByName(id);
    const report = await stub.report();
    if (report === null) {
      return c.json({ error: { tag: 'JobNotFound', message: `No job "${id}"` } }, 404);
    }
    return c.json(report);
  });

  // WebSocket upgrade — forwarded to the DO. Session is checked here on the raw
  // request (the upgrade can't ride Hono's JSON middleware). We forward the
  // ORIGINAL request to the DO so its `fetch` sees the upgrade headers.
  app.get('/jobs/:id/ws', async (c) => {
    if (c.req.header('Upgrade') !== 'websocket') {
      return c.json({ error: { tag: 'BadRequest', message: 'Expected WebSocket upgrade' } }, 426);
    }
    if (!(await hasValidSession(c.req.raw, c.env.SESSION_SECRET))) {
      return c.json({ error: { tag: 'Unauthorized', message: 'Valid session required' } }, 401);
    }
    const id = c.req.param('id');
    const stub = c.env.EXTRACT_JOB.getByName(id);
    return stub.fetch(c.req.raw);
  });

  app.get('/jobs/:id/files', requireSession(), async (c) => {
    const id = c.req.param('id');
    const stub = c.env.EXTRACT_JOB.getByName(id);
    const report = await stub.report();
    if (report === null) {
      return c.json({ error: { tag: 'JobNotFound', message: `No job "${id}"` } }, 404);
    }
    // BYO files live in the user's bucket — we don't list them.
    if (report.destination === 'byo') {
      return c.json({ files: [], destination: 'byo' });
    }
    const cleanPrefix = report.prefix.replace(/\/+$/, '');
    const files: { name: string; key: string; size: number }[] = [];
    let cursor: string | undefined;
    do {
      const listing = await c.env.OUTPUT.list({
        prefix: cleanPrefix ? `${cleanPrefix}/` : undefined,
        cursor,
      });
      for (const obj of listing.objects) {
        const name = cleanPrefix ? obj.key.slice(cleanPrefix.length + 1) : obj.key;
        files.push({ name, key: obj.key, size: obj.size });
      }
      cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor);
    return c.json({ files, destination: 'demo' });
  });

  app.get('/jobs/:id/files/:name{.+}', requireSession(), async (c) => {
    const id = c.req.param('id');
    const name = c.req.param('name');
    const stub = c.env.EXTRACT_JOB.getByName(id);
    const report = await stub.report();
    if (report === null) {
      return c.json({ error: { tag: 'JobNotFound', message: `No job "${id}"` } }, 404);
    }
    if (report.destination === 'byo') {
      return c.json(
        { error: { tag: 'NotAvailable', message: 'BYO files live in your own bucket' } },
        409,
      );
    }
    const cleanPrefix = report.prefix.replace(/\/+$/, '');
    const cleanName = name.replace(/^\/+/, '');
    const key = cleanPrefix ? `${cleanPrefix}/${cleanName}` : cleanName;
    // Guard against path traversal out of the job prefix.
    if (cleanName.includes('..')) {
      return c.json({ error: { tag: 'BadRequest', message: 'Invalid file name' } }, 400);
    }
    const object = await c.env.OUTPUT.get(key);
    if (object === null) {
      return c.json({ error: { tag: 'FileNotFound', message: `No file "${name}"` } }, 404);
    }
    // Stream the object body back — never buffered in the isolate.
    return new Response(object.body, {
      headers: {
        'Content-Length': String(object.size),
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${basename(cleanName)}"`,
      },
    });
  });

  return app;
}

// -------------------------------------------------------------------------------------------------
// Request parsing / validation
// -------------------------------------------------------------------------------------------------

/**
 * Effect operator: assert every requested file name is present in the index.
 * `undefined` (extract-all) always passes. Fails with `EntryNotFoundError` on
 * the first missing name.
 */
function validateRequested(files: string[] | undefined) {
  return (effect: Effect.Effect<readonly ZipEntry[], AppError, Services>) =>
    effect.pipe(
      Effect.flatMap((entries) => {
        if (files === undefined) return Effect.succeed(entries);
        const names = new Set(entries.map((e) => e.name));
        const missing = files.find((f) => !names.has(f));
        return missing === undefined
          ? Effect.succeed(entries)
          : Effect.fail(new EntryNotFoundError(missing));
      }),
    );
}

type ParsedBody =
  | {
      ok: true;
      value: {
        sourceUrl: string;
        prefix: string;
        files?: string[];
        destination: Destination;
        byo?: ByoConfig;
      };
    }
  | { ok: false; reason: string };

export function parseExtractBody(body: ExtractBody | null): ParsedBody {
  if (body === null) return { ok: false, reason: 'Request body must be JSON' };

  if (typeof body.sourceUrl !== 'string' || !isHttpUrl(body.sourceUrl)) {
    return { ok: false, reason: '"sourceUrl" must be an http(s) URL' };
  }
  if (typeof body.prefix !== 'string' || body.prefix.length === 0) {
    return { ok: false, reason: '"prefix" must be a non-empty string' };
  }
  if (body.files !== undefined) {
    if (!Array.isArray(body.files) || !body.files.every((f) => typeof f === 'string')) {
      return { ok: false, reason: '"files" must be an array of strings when provided' };
    }
  }

  // Destination: default to 'demo' when omitted (back-compat).
  const destination: Destination =
    body.destination === 'byo'
      ? 'byo'
      : body.destination === 'demo' || body.destination === undefined
        ? 'demo'
        : 'demo';
  if (body.destination !== undefined && body.destination !== 'demo' && body.destination !== 'byo') {
    return { ok: false, reason: '"destination" must be "demo" or "byo"' };
  }

  let byo: ByoConfig | undefined;
  if (destination === 'byo') {
    const parsed = parseByoConfig(body.byo);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    byo = parsed.value;
  }

  return {
    ok: true,
    value: {
      sourceUrl: body.sourceUrl,
      prefix: body.prefix,
      files: body.files as string[] | undefined,
      destination,
      byo,
    },
  };
}

/**
 * Label a source URL for usage attribution: the matching sample's id if the URL
 * is one of the built-in presets, otherwise the generic "url". Pure lookup over
 * the static preset list — no IO.
 */
export function labelForSource(sourceUrl: string): string {
  const sample = SAMPLE_PRESETS.find((s) => s.url === sourceUrl);
  return sample ? sample.id : 'url';
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Last path segment of a key, for a download filename. */
function basename(key: string): string {
  const parts = key.split('/');
  return parts[parts.length - 1] || key;
}

async function readJson(request: Request): Promise<ExtractBody | null> {
  try {
    return (await request.json()) as ExtractBody;
  } catch {
    return null;
  }
}

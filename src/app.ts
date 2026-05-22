/**
 * HTTP API (Hono).
 *
 *   POST /extract  { sourceUrl, prefix, files? }  -> { jobId, status }
 *   GET  /jobs/:id                                -> JobReport
 *
 * The handler does a cheap pre-flight (read the ZIP index, validate that any
 * explicitly-requested files exist) so a bad request fails with a clear 404
 * BEFORE a job is created. It then hands the job to a per-job Durable Object,
 * which owns the actual extraction and progress tracking.
 */

import { Effect } from 'effect';
import { Hono } from 'hono';
import { readIndex } from './extract';
import { makeRuntime, runSafe, toResponse, type Services } from './effect/runtime';
import { EntryNotFoundError, type AppError } from './effect/errors';
import type { ExtractJob } from './job';
import type { ZipEntry } from './zip';

export interface Env {
  EXTRACT_JOB: DurableObjectNamespace<ExtractJob>;
  OUTPUT: R2Bucket;
}

interface ExtractBody {
  sourceUrl?: unknown;
  prefix?: unknown;
  files?: unknown;
}

export function createApp() {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/', (c) =>
    c.json({
      name: 'rangezip',
      description:
        'Extract files from a remote ZIP via HTTP byte-range reads, without downloading the whole archive.',
      endpoints: {
        'POST /extract': '{ sourceUrl, prefix, files? } -> { jobId, status }',
        'GET /jobs/:id': 'job status + per-file results',
      },
    }),
  );

  app.post('/extract', async (c) => {
    const body = await readJson(c.req.raw);
    const parsed = parseExtractBody(body);
    if (!parsed.ok) {
      return c.json({ error: { tag: 'BadRequest', message: parsed.reason } }, 400);
    }
    const { sourceUrl, prefix, files } = parsed.value;

    // Pre-flight: read the index and validate requested files exist. Cheap —
    // only the tail + central directory are fetched, never the file bodies.
    const rt = makeRuntime(sourceUrl, c.env.OUTPUT);
    try {
      const indexResult = await runSafe(rt, readIndex().pipe(validateRequested(files)));
      if (!indexResult.ok) return toResponse(indexResult.error);
    } finally {
      await rt.dispose();
    }

    const jobId = crypto.randomUUID();
    const stub = c.env.EXTRACT_JOB.getByName(jobId);
    const { status } = await stub.start({ id: jobId, sourceUrl, prefix, files });

    return c.json({ jobId, status }, 202);
  });

  app.get('/jobs/:id', async (c) => {
    const id = c.req.param('id');
    const stub = c.env.EXTRACT_JOB.getByName(id);
    const report = await stub.report();
    if (report === null) {
      return c.json({ error: { tag: 'JobNotFound', message: `No job "${id}"` } }, 404);
    }
    return c.json(report);
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
  | { ok: true; value: { sourceUrl: string; prefix: string; files?: string[] } }
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

  return {
    ok: true,
    value: {
      sourceUrl: body.sourceUrl,
      prefix: body.prefix,
      files: body.files as string[] | undefined,
    },
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

async function readJson(request: Request): Promise<ExtractBody | null> {
  try {
    return (await request.json()) as ExtractBody;
  } catch {
    return null;
  }
}

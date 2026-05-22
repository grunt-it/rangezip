/**
 * App-level routing tests for the auth gate and the demo UI.
 *
 * These drive the Hono app directly (`app.fetch(req, env)`) with a synthetic env
 * carrying the test secrets + the real test DO/R2 bindings — exercising the
 * `/auth` → cookie → gated-route flow end to end without standing up the whole
 * Worker. The WebSocket completion path can't run under the pool's per-file
 * storage isolation (a documented pool limitation), so here we assert the
 * *gating* of the WS route, and the DO's upgrade-accept is covered in
 * `job.test.ts` via `runInDurableObject`.
 */

import { env as testEnv } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp, type Env } from '../src/app';
import { ADMIN_COOKIE, SESSION_COOKIE } from '../src/auth/middleware';
import { REGISTRY_NAME } from '../src/registry/registry';

const app = createApp();

/**
 * Seed real codes into the singleton Registry so `/auth` (which now validates
 * against the Registry, not a static secret) has codes to accept. Runs once;
 * the same codes are reused across the suite.
 */
let SESAME = '';
let OPEN_UP = '';
beforeAll(async () => {
  const reg = testEnv.REGISTRY.getByName(REGISTRY_NAME);
  SESAME = (await reg.createCode('sesame label')).code;
  OPEN_UP = (await reg.createCode('open-up label')).code;
});

/** Synthetic env: test secrets + the real DO/R2 bindings from the pool. */
function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    EXTRACT_JOB: testEnv.EXTRACT_JOB,
    EXTRACT_WORKER: testEnv.EXTRACT_WORKER,
    REGISTRY: testEnv.REGISTRY,
    OUTPUT: testEnv.OUTPUT,
    SESSION_SECRET: 'unit-test-session-secret',
    ADMIN_KEY: 'unit-test-admin-key',
    EXTRACT_TTL_HOURS: '2',
    ...overrides,
  };
}

/** Extract a named cookie token from a Set-Cookie header. */
function namedCookieFrom(res: Response, name: string): string | null {
  const setCookie = res.headers.get('Set-Cookie');
  if (!setCookie) return null;
  const match = setCookie.match(new RegExp(`${name}=([^;]+)`));
  return match ? `${name}=${match[1]}` : null;
}
function cookieFrom(res: Response): string | null {
  return namedCookieFrom(res, SESSION_COOKIE);
}

describe('GET / (demo UI)', () => {
  it('serves the self-contained HTML page', async () => {
    const res = await app.fetch(new Request('https://t/'), makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<title>rangezip');
    expect(html).toContain('Access code');
  });
});

describe('POST /auth', () => {
  it('sets an httpOnly Secure SameSite=Lax cookie on a valid (registry) code', async () => {
    const res = await app.fetch(
      new Request('https://t/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: SESAME }),
      }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('Set-Cookie') ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
  });

  it('rejects an unknown code with 401 and no cookie', async () => {
    const res = await app.fetch(
      new Request('https://t/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'definitely-not-a-real-code' }),
      }),
      makeEnv(),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('rejects a revoked code with 401', async () => {
    const reg = testEnv.REGISTRY.getByName(REGISTRY_NAME);
    const { code } = await reg.createCode('to-revoke');
    await reg.revokeCode(code);
    const res = await app.fetch(
      new Request('https://t/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      }),
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('500s when SESSION_SECRET is unconfigured', async () => {
    const res = await app.fetch(
      new Request('https://t/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: SESAME }),
      }),
      makeEnv({ SESSION_SECRET: undefined }),
    );
    expect(res.status).toBe(500);
  });
});

describe('gated routes', () => {
  it('rejects /jobs/:id without a session', async () => {
    const res = await app.fetch(new Request('https://t/jobs/abc'), makeEnv());
    expect(res.status).toBe(401);
  });

  it('rejects /extract without a session', async () => {
    const res = await app.fetch(
      new Request('https://t/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceUrl: 'https://x/a.zip', destination: 'demo' }),
      }),
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('allows /jobs/:id with a valid session cookie (404 for unknown job, not 401)', async () => {
    const env = makeEnv();
    const auth = await app.fetch(
      new Request('https://t/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: SESAME }),
      }),
      env,
    );
    const cookie = cookieFrom(auth)!;
    const res = await app.fetch(
      new Request('https://t/jobs/no-such-job', { headers: { Cookie: cookie } }),
      env,
    );
    // Authenticated → reaches the handler → 404 (job doesn't exist), NOT 401.
    expect(res.status).toBe(404);
  });

  it('rejects the WS upgrade route without a session (401)', async () => {
    const res = await app.fetch(
      new Request('https://t/jobs/abc/ws', { headers: { Upgrade: 'websocket' } }),
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('426s the WS route for a non-upgrade GET (even before auth)', async () => {
    const res = await app.fetch(new Request('https://t/jobs/abc/ws'), makeEnv());
    expect(res.status).toBe(426);
  });
});

describe('/me and /logout', () => {
  it('/me is 401 without a session, 200 with one', async () => {
    const env = makeEnv();
    expect((await app.fetch(new Request('https://t/me'), env)).status).toBe(401);
    const auth = await app.fetch(
      new Request('https://t/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: OPEN_UP }),
      }),
      env,
    );
    const cookie = cookieFrom(auth)!;
    const me = await app.fetch(new Request('https://t/me', { headers: { Cookie: cookie } }), env);
    expect(me.status).toBe(200);
  });

  it('/logout clears the cookie', async () => {
    const res = await app.fetch(new Request('https://t/logout', { method: 'POST' }), makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });
});

describe('POST /validate-destination', () => {
  it('400s a malformed destination config when authenticated', async () => {
    const env = makeEnv();
    const auth = await app.fetch(
      new Request('https://t/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: SESAME }),
      }),
      env,
    );
    const cookie = cookieFrom(auth)!;
    const res = await app.fetch(
      new Request('https://t/validate-destination', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ destination: { endpoint: 'not-a-url' } }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { valid: boolean };
    expect(body.valid).toBe(false);
  });
});

describe('GET /admin (panel)', () => {
  it('serves the self-contained admin HTML page (no auth needed for the shell)', async () => {
    const res = await app.fetch(new Request('https://t/admin'), makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('rangezip');
    expect(html).toContain('Admin key');
  });
});

describe('admin auth + gating', () => {
  /** Authenticate as admin and return the admin cookie. */
  async function adminCookieToken(env: Env): Promise<string> {
    const res = await app.fetch(
      new Request('https://t/admin/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'unit-test-admin-key' }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    return namedCookieFrom(res, ADMIN_COOKIE)!;
  }

  it('rejects /admin/codes without an admin session (401)', async () => {
    const res = await app.fetch(new Request('https://t/admin/codes'), makeEnv());
    expect(res.status).toBe(401);
  });

  it('rejects a wrong admin key with 401, sets an admin cookie on the right key', async () => {
    const bad = await app.fetch(
      new Request('https://t/admin/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'nope' }),
      }),
      makeEnv(),
    );
    expect(bad.status).toBe(401);
    expect(bad.headers.get('Set-Cookie')).toBeNull();

    const good = await app.fetch(
      new Request('https://t/admin/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'unit-test-admin-key' }),
      }),
      makeEnv(),
    );
    expect(good.status).toBe(200);
    const setCookie = good.headers.get('Set-Cookie') ?? '';
    expect(setCookie).toContain(`${ADMIN_COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');
  });

  it('an ACCESS-CODE session does NOT satisfy the admin gate', async () => {
    const env = makeEnv();
    const auth = await app.fetch(
      new Request('https://t/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: SESAME }),
      }),
      env,
    );
    const codeCookie = cookieFrom(auth)!;
    const res = await app.fetch(
      new Request('https://t/admin/codes', { headers: { Cookie: codeCookie } }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('an ADMIN session does NOT satisfy the access-code gate', async () => {
    const env = makeEnv();
    const cookie = await adminCookieToken(env);
    const res = await app.fetch(
      new Request('https://t/jobs/some-job', { headers: { Cookie: cookie } }),
      env,
    );
    // Admin cookie present, but the code gate rejects it → 401, not 404.
    expect(res.status).toBe(401);
  });

  it('creates, lists, and revokes a code through the admin API', async () => {
    const env = makeEnv();
    const cookie = await adminCookieToken(env);

    const created = await app.fetch(
      new Request('https://t/admin/codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ label: 'admin-api-test' }),
      }),
      env,
    );
    expect(created.status).toBe(201);
    const { code } = (await created.json()) as { code: string; label: string };
    expect(code).toMatch(/^[0-9A-Za-z]{10}$/);

    const list = await app.fetch(
      new Request('https://t/admin/codes', { headers: { Cookie: cookie } }),
      env,
    );
    const { codes } = (await list.json()) as { codes: Array<{ code: string; label: string }> };
    expect(codes.some((c) => c.code === code && c.label === 'admin-api-test')).toBe(true);

    const revoked = await app.fetch(
      new Request(`https://t/admin/codes/${code}/revoke`, {
        method: 'POST',
        headers: { Cookie: cookie },
      }),
      env,
    );
    expect(revoked.status).toBe(200);

    // A revoked code can no longer sign in.
    const signin = await app.fetch(
      new Request('https://t/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      }),
      env,
    );
    expect(signin.status).toBe(401);
  });
});

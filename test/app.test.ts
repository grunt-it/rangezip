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
import { describe, expect, it } from 'vitest';
import { createApp, type Env } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/middleware';

const app = createApp();

/** Synthetic env: test secrets + the real DO/R2 bindings from the pool. */
function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    EXTRACT_JOB: testEnv.EXTRACT_JOB,
    OUTPUT: testEnv.OUTPUT,
    ACCESS_CODES: 'sesame, open-up',
    SESSION_SECRET: 'unit-test-session-secret',
    EXTRACT_TTL_HOURS: '2',
    ...overrides,
  };
}

/** Extract the session cookie token from a Set-Cookie header. */
function cookieFrom(res: Response): string | null {
  const setCookie = res.headers.get('Set-Cookie');
  if (!setCookie) return null;
  const match = setCookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return match ? `${SESSION_COOKIE}=${match[1]}` : null;
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
  it('sets an httpOnly Secure SameSite=Lax cookie on a valid code', async () => {
    const res = await app.fetch(
      new Request('https://t/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'sesame' }),
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

  it('rejects an invalid code with 401 and no cookie', async () => {
    const res = await app.fetch(
      new Request('https://t/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'wrong' }),
      }),
      makeEnv(),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('500s when ACCESS_CODES / SESSION_SECRET are unconfigured', async () => {
    const res = await app.fetch(
      new Request('https://t/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'sesame' }),
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
        body: JSON.stringify({ sourceUrl: 'https://x/a.zip', prefix: 'p', destination: 'demo' }),
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
        body: JSON.stringify({ code: 'sesame' }),
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
        body: JSON.stringify({ code: 'open-up' }),
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
        body: JSON.stringify({ code: 'sesame' }),
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

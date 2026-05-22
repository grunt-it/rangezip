/**
 * Auth shell: the session cookie name, cookie serialisation, and the Hono
 * middleware that gates protected routes.
 *
 * The pure signing/verification lives in `./session`; this module is the thin
 * Hono-aware layer that reads the cookie off the request, verifies it, and
 * either continues or 401s. It also exposes `sessionCookie()` for the `/auth`
 * handler to set on a successful login.
 */

import type { MiddlewareHandler } from 'hono';
import { verifySession } from './session';

/** Name of the session cookie. */
export const SESSION_COOKIE = 'rangezip_session';

/** Read a named cookie value from a request's `Cookie` header. */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Build a `Set-Cookie` value for the session token. `httpOnly` so JS can't read
 * it, `Secure` so it only rides HTTPS, `SameSite=Lax` so it survives top-level
 * navigations but not cross-site POSTs, `Path=/` for the whole app, and
 * `Max-Age` matching the token TTL.
 */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

/** A `Set-Cookie` value that immediately clears the session cookie. */
export function clearSessionCookie(): string {
  return [`${SESSION_COOKIE}=`, 'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=0'].join(
    '; ',
  );
}

/** Env fields the auth layer needs. */
export interface AuthEnv {
  SESSION_SECRET?: string;
  ACCESS_CODES?: string;
}

/**
 * Middleware that requires a valid session cookie. On failure it returns a
 * `401` JSON error and does NOT call `next()`. The session secret comes from
 * env — if it's unset the gate fails closed (everything is unauthorised), since
 * a missing secret means no token could ever have been validly signed.
 */
export function requireSession(): MiddlewareHandler<{ Bindings: AuthEnv }> {
  return async (c, next) => {
    const secret = c.env.SESSION_SECRET;
    if (!secret) {
      return c.json(
        { error: { tag: 'Unconfigured', message: 'SESSION_SECRET is not configured' } },
        500,
      );
    }
    const token = readCookie(c.req.header('Cookie'), SESSION_COOKIE);
    const result = await verifySession(secret, token);
    if (!result.ok) {
      return c.json({ error: { tag: 'Unauthorized', message: 'Valid session required' } }, 401);
    }
    return next();
  };
}

/**
 * Verify the session on a raw `Request` (used for the WebSocket upgrade path,
 * which is handled outside Hono's normal middleware chain since it forwards to
 * the DO). Returns true if the request carries a valid session cookie.
 */
export async function hasValidSession(
  request: Request,
  secret: string | undefined,
): Promise<boolean> {
  if (!secret) return false;
  const token = readCookie(request.headers.get('Cookie'), SESSION_COOKIE);
  const result = await verifySession(secret, token);
  return result.ok;
}

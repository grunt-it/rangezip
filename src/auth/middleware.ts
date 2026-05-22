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

/** Name of the access-code session cookie. */
export const SESSION_COOKIE = 'rangezip_session';

/**
 * Name of the ADMIN session cookie — deliberately distinct from
 * {@link SESSION_COOKIE}. The two are mutually exclusive at the wire level: an
 * admin cookie can never satisfy a code-gated route and vice versa, because each
 * gate only reads its own cookie name. The `sub` sentinel below is the second
 * layer of that defence.
 */
export const ADMIN_COOKIE = 'rangezip_admin';

/**
 * The `sub` carried by an admin session token. Code sessions set `sub` to the
 * access code; the admin session sets it to this sentinel, so even a token
 * presented under the wrong cookie name fails the `sub` check.
 */
export const ADMIN_SUBJECT = 'admin';

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
 * Build a `Set-Cookie` value for a session token under a given cookie `name`.
 * `httpOnly` so JS can't read it, `Secure` so it only rides HTTPS,
 * `SameSite=Lax` so it survives top-level navigations but not cross-site POSTs,
 * `Path=/` for the whole app, and `Max-Age` matching the token TTL.
 */
export function buildSessionCookie(name: string, token: string, maxAgeSeconds: number): string {
  return [
    `${name}=${token}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

/** A `Set-Cookie` value that immediately clears the named cookie. */
export function buildClearCookie(name: string): string {
  return [`${name}=`, 'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=0'].join('; ');
}

/** `Set-Cookie` for the access-code session. */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return buildSessionCookie(SESSION_COOKIE, token, maxAgeSeconds);
}

/** `Set-Cookie` that clears the access-code session. */
export function clearSessionCookie(): string {
  return buildClearCookie(SESSION_COOKIE);
}

/** `Set-Cookie` for the admin session. */
export function adminCookie(token: string, maxAgeSeconds: number): string {
  return buildSessionCookie(ADMIN_COOKIE, token, maxAgeSeconds);
}

/** `Set-Cookie` that clears the admin session. */
export function clearAdminCookie(): string {
  return buildClearCookie(ADMIN_COOKIE);
}

/** Env fields the auth layer needs. */
export interface AuthEnv {
  SESSION_SECRET?: string;
  /** Admin-panel key (secret); gates `/admin/*`. */
  ADMIN_KEY?: string;
}

/**
 * Middleware that requires a valid ACCESS-CODE session cookie. On failure it
 * returns a `401` JSON error and does NOT call `next()`. The session secret
 * comes from env — if it's unset the gate fails closed (everything is
 * unauthorised), since a missing secret means no token could ever have been
 * validly signed. An admin session does NOT satisfy this gate: it rides a
 * different cookie name and carries the {@link ADMIN_SUBJECT} sentinel, which is
 * rejected here.
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
    if (!result.ok || result.payload.sub === ADMIN_SUBJECT) {
      return c.json({ error: { tag: 'Unauthorized', message: 'Valid session required' } }, 401);
    }
    return next();
  };
}

/**
 * Middleware that requires a valid ADMIN session cookie. Reads the
 * {@link ADMIN_COOKIE} (NOT the access-code cookie) and requires the
 * {@link ADMIN_SUBJECT} sentinel `sub`, so a code session can never satisfy it.
 * Fails closed if `SESSION_SECRET` is unset.
 */
export function requireAdmin(): MiddlewareHandler<{ Bindings: AuthEnv }> {
  return async (c, next) => {
    const secret = c.env.SESSION_SECRET;
    if (!secret) {
      return c.json(
        { error: { tag: 'Unconfigured', message: 'SESSION_SECRET is not configured' } },
        500,
      );
    }
    const token = readCookie(c.req.header('Cookie'), ADMIN_COOKIE);
    const result = await verifySession(secret, token);
    if (!result.ok || result.payload.sub !== ADMIN_SUBJECT) {
      return c.json({ error: { tag: 'Unauthorized', message: 'Admin session required' } }, 401);
    }
    return next();
  };
}

/**
 * Verify the access-code session on a raw `Request` (used for the WebSocket
 * upgrade path, which is handled outside Hono's normal middleware chain since it
 * forwards to the DO). Returns true if the request carries a valid access-code
 * session cookie (an admin cookie does not count — wrong cookie name + sub).
 */
export async function hasValidSession(
  request: Request,
  secret: string | undefined,
): Promise<boolean> {
  if (!secret) return false;
  const token = readCookie(request.headers.get('Cookie'), SESSION_COOKIE);
  const result = await verifySession(secret, token);
  return result.ok && result.payload.sub !== ADMIN_SUBJECT;
}

/**
 * Read the access code off a valid session cookie on a raw `Request`, or null if
 * absent/invalid/admin. Used to attribute job activity to the code that started
 * the session.
 */
export async function sessionCode(
  request: Request,
  secret: string | undefined,
): Promise<string | null> {
  if (!secret) return null;
  const token = readCookie(request.headers.get('Cookie'), SESSION_COOKIE);
  const result = await verifySession(secret, token);
  if (!result.ok || result.payload.sub === ADMIN_SUBJECT) return null;
  return result.payload.sub;
}

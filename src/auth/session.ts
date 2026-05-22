/**
 * Session token signing + verification — pure crypto over the WebCrypto API.
 *
 * A session token is a stateless, signed bearer credential:
 *
 *   <base64url(payloadJson)>.<base64url(hmacSha256(payloadJson))>
 *
 * The payload is `{ sub, exp }` where `exp` is a unix-ms expiry. The signature
 * is an HMAC-SHA256 over the *encoded payload string* using `SESSION_SECRET`.
 * Verification recomputes the HMAC (constant-time compared) and rejects expired
 * tokens. No server-side session store — the signature IS the proof.
 *
 * This module is deliberately free of Hono / Workers globals beyond WebCrypto
 * (`crypto.subtle`, available in both `workerd` and the test pool) and
 * `TextEncoder`, so the signing/verification logic is unit-testable in isolation
 * without an HTTP runtime — matching the repo's pure-logic-vs-shell split.
 */

const encoder = new TextEncoder();

/** Decoded session payload. `exp` is unix epoch milliseconds. */
export interface SessionPayload {
  /** Subject — an opaque identifier for the authenticated session. */
  readonly sub: string;
  /** Expiry, unix epoch milliseconds. */
  readonly exp: number;
}

/** Default session lifetime: 24 hours, in milliseconds. */
export const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// -------------------------------------------------------------------------------------------------
// base64url (no padding) — URL/cookie-safe, no '+', '/', or '='
// -------------------------------------------------------------------------------------------------

/** Encode bytes as unpadded base64url. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode unpadded base64url back to bytes. Returns null on malformed input. */
export function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------------
// HMAC
// -------------------------------------------------------------------------------------------------

/** Import the secret as an HMAC-SHA256 signing key. */
async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/** Compute the raw HMAC-SHA256 of `message` under `secret`. */
async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return new Uint8Array(sig);
}

/**
 * Constant-time byte comparison. Avoids early-exit so the time taken does not
 * leak how many leading bytes matched (mitigates signature-forgery timing
 * attacks). Length mismatch fails, but only after a full fixed-length scan.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

// -------------------------------------------------------------------------------------------------
// sign / verify
// -------------------------------------------------------------------------------------------------

/**
 * Sign a session payload, producing `<payload>.<signature>` (both base64url).
 * `sub` defaults to a random UUID; `now`/`ttlMs` are injectable for tests.
 */
export async function signSession(
  secret: string,
  options: { sub?: string; ttlMs?: number; now?: number } = {},
): Promise<string> {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  const payload: SessionPayload = {
    sub: options.sub ?? crypto.randomUUID(),
    exp: now + ttlMs,
  };
  const encodedPayload = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = base64UrlEncode(await hmac(secret, encodedPayload));
  return `${encodedPayload}.${signature}`;
}

/** Result of verifying a session token. */
export type VerifyResult =
  | { readonly ok: true; readonly payload: SessionPayload }
  | { readonly ok: false; readonly reason: string };

/**
 * Verify a `<payload>.<signature>` token: recompute the HMAC, compare in
 * constant time, then check expiry. Returns the decoded payload on success or
 * a typed reason on failure. Never throws on malformed input — returns
 * `{ ok: false }`.
 */
export async function verifySession(
  secret: string,
  token: string | undefined | null,
  now: number = Date.now(),
): Promise<VerifyResult> {
  if (!token) return { ok: false, reason: 'missing token' };

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) {
    return { ok: false, reason: 'malformed token' };
  }
  const encodedPayload = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  const expectedSig = base64UrlEncode(await hmac(secret, encodedPayload));
  // Compare as bytes (constant-time); ASCII so encoder is exact.
  if (!timingSafeEqual(encoder.encode(providedSig), encoder.encode(expectedSig))) {
    return { ok: false, reason: 'bad signature' };
  }

  const payloadBytes = base64UrlDecode(encodedPayload);
  if (!payloadBytes) return { ok: false, reason: 'undecodable payload' };

  let payload: SessionPayload;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as SessionPayload).sub !== 'string' ||
      typeof (parsed as SessionPayload).exp !== 'number'
    ) {
      return { ok: false, reason: 'invalid payload shape' };
    }
    payload = parsed as SessionPayload;
  } catch {
    return { ok: false, reason: 'unparseable payload' };
  }

  if (now >= payload.exp) return { ok: false, reason: 'expired' };

  return { ok: true, payload };
}

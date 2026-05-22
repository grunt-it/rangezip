/**
 * Pure auth tests: session signing/verification (HMAC-SHA256 over the encoded
 * payload), base64url round-trips, constant-time comparison, and access-code
 * checking. These run inside the Workers pool so they use the real WebCrypto
 * `crypto.subtle` — the same primitive production uses.
 */

import { describe, expect, it } from 'vitest';
import {
  base64UrlDecode,
  base64UrlEncode,
  DEFAULT_SESSION_TTL_MS,
  signSession,
  timingSafeEqual,
  verifySession,
} from '../src/auth/session';
import { isValidAccessCode, parseAccessCodes } from '../src/auth/codes';

const SECRET = 'test-session-secret-please-rotate';

describe('base64url', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 62, 63]);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toMatch(/[+/=]/); // url-safe, no padding
    expect(base64UrlDecode(encoded)).toEqual(bytes);
  });

  it('returns null on malformed input', () => {
    expect(base64UrlDecode('!!!not base64!!!')).toBeNull();
  });
});

describe('timingSafeEqual', () => {
  it('is true for equal byte arrays', () => {
    const a = new TextEncoder().encode('hello');
    const b = new TextEncoder().encode('hello');
    expect(timingSafeEqual(a, b)).toBe(true);
  });
  it('is false for different content of equal length', () => {
    const a = new TextEncoder().encode('hello');
    const b = new TextEncoder().encode('hellp');
    expect(timingSafeEqual(a, b)).toBe(false);
  });
  it('is false for different lengths', () => {
    const a = new TextEncoder().encode('hi');
    const b = new TextEncoder().encode('hiya');
    expect(timingSafeEqual(a, b)).toBe(false);
  });
});

describe('signSession / verifySession', () => {
  it('signs and verifies a fresh token', async () => {
    const token = await signSession(SECRET, { sub: 'user-1', now: 1000 });
    const result = await verifySession(SECRET, token, 2000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sub).toBe('user-1');
      expect(result.payload.exp).toBe(1000 + DEFAULT_SESSION_TTL_MS);
    }
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signSession(SECRET, { now: 1000 });
    const result = await verifySession('a-different-secret', token, 2000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad signature');
  });

  it('rejects an expired token', async () => {
    const token = await signSession(SECRET, { ttlMs: 1000, now: 0 });
    const result = await verifySession(SECRET, token, 5000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('accepts a token exactly before expiry and rejects exactly at expiry', async () => {
    const token = await signSession(SECRET, { ttlMs: 1000, now: 0 }); // exp = 1000
    expect((await verifySession(SECRET, token, 999)).ok).toBe(true);
    expect((await verifySession(SECRET, token, 1000)).ok).toBe(false);
  });

  it('rejects a tampered payload (signature no longer matches)', async () => {
    const token = await signSession(SECRET, { sub: 'user-1', now: 1000 });
    const [payload, sig] = token.split('.');
    // Flip the payload to a forged one but keep the original signature.
    const forgedPayload = base64UrlEncode(
      new TextEncoder().encode(JSON.stringify({ sub: 'admin', exp: 9e15 })),
    );
    const tampered = `${forgedPayload}.${sig}`;
    expect(payload).not.toBe(forgedPayload);
    const result = await verifySession(SECRET, tampered, 2000);
    expect(result.ok).toBe(false);
  });

  it('rejects missing / malformed tokens without throwing', async () => {
    expect((await verifySession(SECRET, undefined)).ok).toBe(false);
    expect((await verifySession(SECRET, '')).ok).toBe(false);
    expect((await verifySession(SECRET, 'no-dot')).ok).toBe(false);
    expect((await verifySession(SECRET, '.sig')).ok).toBe(false);
    expect((await verifySession(SECRET, 'payload.')).ok).toBe(false);
  });
});

describe('parseAccessCodes', () => {
  it('splits, trims, and drops empties', () => {
    expect(parseAccessCodes(' a , b ,,c , ')).toEqual(['a', 'b', 'c']);
  });
  it('returns [] for undefined or empty', () => {
    expect(parseAccessCodes(undefined)).toEqual([]);
    expect(parseAccessCodes('')).toEqual([]);
    expect(parseAccessCodes('  ,  ')).toEqual([]);
  });
});

describe('isValidAccessCode', () => {
  const codes = parseAccessCodes('alpha, bravo, charlie');
  it('accepts a configured code (trimmed)', () => {
    expect(isValidAccessCode('bravo', codes)).toBe(true);
    expect(isValidAccessCode('  bravo  ', codes)).toBe(true);
  });
  it('rejects an unknown code', () => {
    expect(isValidAccessCode('delta', codes)).toBe(false);
  });
  it('rejects empty submission or empty config', () => {
    expect(isValidAccessCode('', codes)).toBe(false);
    expect(isValidAccessCode('   ', codes)).toBe(false);
    expect(isValidAccessCode('alpha', [])).toBe(false);
  });
  it('is case-sensitive (exact match only)', () => {
    expect(isValidAccessCode('ALPHA', codes)).toBe(false);
  });
});

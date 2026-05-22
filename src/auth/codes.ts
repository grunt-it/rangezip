/**
 * Access-code checking — pure logic over the `ACCESS_CODES` secret.
 *
 * `ACCESS_CODES` is a comma-separated list of multi-use access codes (read from
 * env at request time; NEVER hardcoded). Codes are trimmed and empty entries
 * dropped, so `" a , b ,"` parses to `['a', 'b']`. A submitted code matches if it
 * equals any configured code after trimming. The comparison is constant-time per
 * candidate so the time taken doesn't leak which code (or how much of one)
 * matched.
 */

import { timingSafeEqual } from './session';

const encoder = new TextEncoder();

/** Parse the comma-separated `ACCESS_CODES` secret into a clean code list. */
export function parseAccessCodes(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * Is `submitted` one of the configured access codes? Trims the submission, then
 * compares constant-time against each configured code. Returns false for an
 * empty submission or empty config.
 */
export function isValidAccessCode(submitted: string, configured: readonly string[]): boolean {
  const candidate = submitted.trim();
  if (candidate.length === 0) return false;
  const candidateBytes = encoder.encode(candidate);
  // Scan ALL codes (no early return) so total time doesn't leak which matched.
  let matched = false;
  for (const code of configured) {
    if (timingSafeEqual(candidateBytes, encoder.encode(code))) matched = true;
  }
  return matched;
}

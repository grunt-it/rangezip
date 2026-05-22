/**
 * Access-code registry — the PURE half.
 *
 * The `Registry` Durable Object is the source of truth for access codes and the
 * usage events attributed to them. This module holds the bits that are pure
 * functions over plain data so they're trivially unit-testable without a runtime
 * (matching the repo's pure-logic-vs-Effect-shell discipline):
 *
 *   - `generateCode` — a random, URL-safe ~10-char code (crypto-random).
 *   - `aggregateUsage` — fold a code's `usage_events` rows into the summary row
 *     the admin panel renders (redeemed?, last active, #sessions, #jobs, #files,
 *     bytes). This is the read-model reducer; the DO just feeds it the rows.
 *
 * The DO shell (`./registry`) owns the SQLite IO and calls these.
 */

/**
 * A scalar an event-detail field can hold. Deliberately flat (no nested objects
 * or arrays): event details are always flat key→scalar maps, and a flat type
 * stays cheaply DO-RPC-serializable — a fully recursive JSON type blows the RPC
 * `Serializable` type computation's depth budget.
 */
export type DetailScalar = string | number | boolean | null;

/** A usage-event detail payload: a flat map of scalars (or null when absent). */
export type DetailObject = { readonly [key: string]: DetailScalar };

/** A usage event as stored/replayed. `detail` is already-parsed JSON (or null). */
export interface UsageEvent {
  readonly id: number;
  readonly code: string;
  readonly type: string;
  /** Parsed detail payload — a flat scalar map, shape depends on `type`. */
  readonly detail: DetailObject | null;
  /** Unix-ms timestamp. */
  readonly at: number;
}

/** A code's stored metadata (the `codes` table row). */
export interface CodeRecord {
  readonly code: string;
  readonly label: string;
  readonly createdAt: number;
  /** Unix-ms when revoked, or null if active. */
  readonly revokedAt: number | null;
}

/** The aggregated, admin-panel-facing view of one code. */
export interface CodeSummary extends CodeRecord {
  /** True once at least one session has started under this code. */
  readonly redeemed: boolean;
  /** Unix-ms of the most recent event, or null if never used. */
  readonly lastActiveAt: number | null;
  /** Count of `session_start` events. */
  readonly sessions: number;
  /** Count of `job_started` events. */
  readonly jobs: number;
  /** Sum of `filesExtracted` across `job_completed` events. */
  readonly filesExtracted: number;
  /** Sum of `bytes` across `job_completed` events. */
  readonly bytes: number;
}

// -------------------------------------------------------------------------------------------------
// Code generation
// -------------------------------------------------------------------------------------------------

/**
 * The alphabet for generated codes. URL-safe and unambiguous: no `+`/`/`/`=`, no
 * `0`/`O`/`1`/`l`/`I` so a code read off a screen can't be mistyped. 50 symbols.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';

/** Default generated-code length. ~10 chars over a 56-symbol alphabet ≈ 58 bits. */
export const DEFAULT_CODE_LENGTH = 10;

/**
 * Generate a random URL-safe access code of `length` characters from
 * {@link CODE_ALPHABET}. Uses `crypto.getRandomValues` (CSPRNG) and rejection
 * sampling so the distribution over the alphabet is unbiased — no modulo skew.
 *
 * Pure in the sense that matters here: no IO, no network, no storage. It does
 * read the global CSPRNG (available in both `workerd` and the test pool), which
 * is the only non-determinism — exactly like `crypto.randomUUID()` elsewhere.
 */
export function generateCode(length: number = DEFAULT_CODE_LENGTH): string {
  const alphabetLen = CODE_ALPHABET.length;
  // Largest multiple of alphabetLen that fits in a byte; bytes at/above it are
  // rejected so every accepted byte maps uniformly onto the alphabet.
  const limit = Math.floor(256 / alphabetLen) * alphabetLen;
  let out = '';
  const buf = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < length; i++) {
      const byte = buf[i] ?? 0;
      if (byte < limit) out += CODE_ALPHABET[byte % alphabetLen];
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// Usage aggregation (the read-model reducer)
// -------------------------------------------------------------------------------------------------

/** Event-type constants — the only types the reducer recognises. */
export const EVENT_TYPES = {
  sessionStart: 'session_start',
  jobStarted: 'job_started',
  jobCompleted: 'job_completed',
} as const;

/** Pull a finite non-negative number off a detail field, defaulting to 0. */
function num(detail: DetailObject | null, key: string): number {
  if (!detail) return 0;
  const v = detail[key];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * Fold a code's events into its admin summary. Pure: same `record` + `events`
 * yields the same summary, no IO. `events` need not be sorted — `lastActiveAt`
 * is the max `at` seen.
 *
 *   - `sessions`        = count of `session_start`
 *   - `jobs`            = count of `job_started`
 *   - `filesExtracted`  = Σ `detail.filesExtracted` over `job_completed`
 *   - `bytes`           = Σ `detail.bytes` over `job_completed`
 *   - `redeemed`        = at least one `session_start`
 *   - `lastActiveAt`    = max `at` over all events (null if none)
 */
export function aggregateUsage(record: CodeRecord, events: readonly UsageEvent[]): CodeSummary {
  let sessions = 0;
  let jobs = 0;
  let filesExtracted = 0;
  let bytes = 0;
  let lastActiveAt: number | null = null;

  for (const ev of events) {
    if (lastActiveAt === null || ev.at > lastActiveAt) lastActiveAt = ev.at;
    switch (ev.type) {
      case EVENT_TYPES.sessionStart:
        sessions += 1;
        break;
      case EVENT_TYPES.jobStarted:
        jobs += 1;
        break;
      case EVENT_TYPES.jobCompleted:
        filesExtracted += num(ev.detail, 'filesExtracted');
        bytes += num(ev.detail, 'bytes');
        break;
      default:
        // Unknown event types still count toward lastActiveAt (above) but carry
        // no aggregate meaning — forward-compatible with new event types.
        break;
    }
  }

  return {
    ...record,
    redeemed: sessions > 0,
    lastActiveAt,
    sessions,
    jobs,
    filesExtracted,
    bytes,
  };
}

/**
 * Is this code currently usable? Active means it exists and has not been revoked.
 * Pure boolean over a (possibly absent) record.
 */
export function isCodeActive(record: CodeRecord | undefined | null): boolean {
  return !!record && record.revokedAt === null;
}

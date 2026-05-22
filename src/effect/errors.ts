/**
 * Tagged errors, in the app-template house style.
 *
 * Every error is a `Data.TaggedError` carrying `{ message, status, cause? }`
 * (plus arbitrary extra fields). The `status` is an HTTP status — the Effect
 * runner maps a failed Effect straight to a `Response` with that status, so the
 * error channel doubles as the HTTP contract. No `try/catch` swallowing
 * anywhere: failures travel as typed values in the Effect error channel.
 */

import { Data } from 'effect';

export interface ErrorParams {
  message: string;
  status: number;
  cause?: unknown;
  [key: string]: unknown;
}

/** Structural guard: is this a tagged error of ours (message + status + _tag)? */
export function isTaggedError(error: unknown): error is { _tag: string } & ErrorParams {
  return (
    typeof error === 'object' &&
    error !== null &&
    '_tag' in error &&
    typeof (error as { _tag: unknown })._tag === 'string' &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  );
}

/**
 * A byte-range GET against the source URL failed or returned the wrong shape.
 *
 * Carries a `retryable` flag so the range-fetch retry policy (exponential
 * backoff + jitter, see `services.ts`) can retry transient failures — HTTP 429
 * / 503 / 502 / 500 and network/timeout/connection errors — while letting
 * permanent failures (404 / 416 / 403 / 401, other permanent 4xx, malformed
 * Content-Range) fail fast. `retryAfterMs`, when set, is a server-requested
 * minimum cooldown parsed from a `Retry-After` header (capped); the fetch sleeps
 * it before failing so the next retry honours it as a floor.
 */
export class RangeFetchError extends Data.TaggedError('RangeFetchError')<ErrorParams> {
  /** Whether this failure is worth retrying (transient). Defaults to `false`. */
  readonly retryable: boolean;
  /** Server-requested cooldown (ms) from a `Retry-After` header, if any. */
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    cause?: unknown,
    options: { retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super({
      message,
      status: 502,
      cause,
      retryable: options.retryable ?? false,
      retryAfterMs: options.retryAfterMs,
    });
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** The bytes we fetched are not a parseable ZIP (bad signature, truncated, …). */
export class ZipParseError extends Data.TaggedError('ZipParseError')<ErrorParams> {
  constructor(message: string, cause?: unknown) {
    super({ message, status: 422, cause });
  }
}

/** A requested entry name is not present in the archive's central directory. */
export class EntryNotFoundError extends Data.TaggedError('EntryNotFoundError')<ErrorParams> {
  constructor(name: string, cause?: unknown) {
    super({ message: `Entry "${name}" not found in archive`, status: 404, name, cause });
  }
}

/** Writing the extracted object into R2 failed. */
export class R2WriteError extends Data.TaggedError('R2WriteError')<ErrorParams> {
  constructor(message: string, cause?: unknown) {
    super({ message, status: 500, cause });
  }
}

/** Inflating a DEFLATE entry failed (corrupt stream, size mismatch, …). */
export class DecompressError extends Data.TaggedError('DecompressError')<ErrorParams> {
  constructor(message: string, cause?: unknown) {
    super({ message, status: 422, cause });
  }
}

/** Union of every domain error — the Effect error channel for this app. */
export type AppError =
  | RangeFetchError
  | ZipParseError
  | EntryNotFoundError
  | R2WriteError
  | DecompressError;

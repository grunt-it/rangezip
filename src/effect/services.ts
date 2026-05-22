/**
 * Services — the IO seams of the app, modelled as `Context.Tag`s and provided
 * as `Layer`s built from Workers `env` bindings at request/DO construction time.
 *
 * `Source`  — byte-range reader over the remote ZIP URL.
 * `Bucket`  — the R2 binding we stream extracted objects into.
 *
 * Because both are tags, the pure extraction logic depends on capabilities, not
 * on `fetch` or a concrete R2 binding — which keeps it swappable in tests.
 */

import { Context, Effect, Layer, Schedule } from 'effect';
import { R2WriteError, RangeFetchError } from './errors';
import type { MetricsSink } from './metrics-sink';

// -------------------------------------------------------------------------------------------------
// Range-fetch retry policy
// -------------------------------------------------------------------------------------------------

/**
 * HTTP statuses that represent a TRANSIENT source failure worth retrying:
 * rate-limiting (429) and the transient 5xx family that an origin / CDN throws
 * under load (500/502/503). Everything else (404/416/403/401, other permanent
 * 4xx) is a PERMANENT failure — retrying just burns the attempt budget.
 *
 * The live failure mode this exists for: under the 144-way DO fan-out the
 * source (R2's public `r2.dev` URL) rate-limits a chunk of range fetches with
 * 429; the 429 clears on a backed-off retry.
 */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503]);

/** Statuses for which a `Retry-After` header is meaningful (and worth honouring). */
const RETRY_AFTER_STATUSES = new Set([429, 503]);

/** Base delay for the exponential backoff between range-fetch retries. */
const RETRY_BASE_DELAY = '250 millis';
/** Hard cap on retry attempts (so a genuinely-down source fails in bounded time). */
const RETRY_MAX_RECURRENCES = 5;
/** Overall elapsed budget — a second guard so retries can't run unbounded. */
const RETRY_MAX_ELAPSED = '30 seconds';
/** Cap on how long a server-supplied `Retry-After` can hold us (avoid a 1h park). */
const RETRY_AFTER_CAP_MS = 5_000;

/**
 * The retry schedule for range fetches: exponential backoff (250ms base, ×2)
 * with full jitter to de-correlate the 144 workers' retries, intersected with a
 * recurrence cap AND an elapsed-time cap (whichever trips first stops it). The
 * `intersect` semantics mean BOTH the per-step backoff schedule and the caps
 * must agree to continue, so it stops at 5 retries or 30s elapsed.
 */
const rangeRetrySchedule = Schedule.exponential(RETRY_BASE_DELAY).pipe(
  Schedule.jittered,
  Schedule.intersect(Schedule.recurs(RETRY_MAX_RECURRENCES)),
  Schedule.upTo(RETRY_MAX_ELAPSED),
);

/**
 * Parse a `Retry-After` header into milliseconds, capped at {@link RETRY_AFTER_CAP_MS}.
 * Supports both the delta-seconds form (`Retry-After: 3`) and the HTTP-date form
 * (`Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`). Returns `undefined` if absent
 * or unparseable. Negative / past dates clamp to 0.
 */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (trimmed === '') return undefined;

  // delta-seconds form
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, RETRY_AFTER_CAP_MS);
  }
  // HTTP-date form
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  const deltaMs = when - Date.now();
  return Math.min(Math.max(deltaMs, 0), RETRY_AFTER_CAP_MS);
}

// -------------------------------------------------------------------------------------------------
// Source — range reads over the remote archive
// -------------------------------------------------------------------------------------------------

/** A half-open byte range `[start, end)` within the source object. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

export class Source extends Context.Tag('Source')<
  Source,
  {
    /** Total size of the source object in bytes (from a HEAD / Content-Range). */
    readonly size: Effect.Effect<number, RangeFetchError>;
    /** Range-GET `[start, end)` and return the bytes. */
    readonly readRange: (range: ByteRange) => Effect.Effect<Uint8Array, RangeFetchError>;
    /**
     * Range-GET `[start, end)` as a stream — used for the (potentially large)
     * compressed payload so we never materialise it fully in memory.
     */
    readonly streamRange: (
      range: ByteRange,
    ) => Effect.Effect<ReadableStream<Uint8Array>, RangeFetchError>;
  }
>() {}

/**
 * HTTP-backed `Source`. Issues `Range: bytes=start-end` requests and discovers
 * the total size from the `Content-Range` header of a 1-byte probe (more
 * reliable than HEAD, which some object stores answer without a length).
 *
 * If a `MetricsSink` is provided, every range-GET and the size probe are
 * recorded with their REAL byte spans, so the headline "bytes fetched" metric
 * reflects bytes actually pulled over the wire.
 */
export function makeHttpSource(sourceUrl: string, metrics?: MetricsSink): Layer.Layer<Source> {
  /**
   * Issue one `Range` GET and assert a usable status, retrying transient
   * failures with backoff. The retry wraps fetch + the 206/200 status check, so
   * a retryable status (or a network/timeout/connection error) re-issues the
   * whole range request; only once a usable response arrives do callers stream
   * its body. The success metric (`metrics?.range`) is recorded INSIDE the
   * retried unit but only on the success branch, so retried 429s don't double-
   * count bytes — the metric fires exactly once, when the fetch finally lands.
   */
  const fetchRangeOnce = (headers: Record<string, string>, onSuccess: () => void) =>
    Effect.tryPromise({
      try: () => fetch(sourceUrl, { headers }),
      // A thrown fetch = network/timeout/connection error: transient, retry it.
      catch: (cause) =>
        new RangeFetchError(`Network error fetching range from ${sourceUrl}`, cause, {
          retryable: true,
        }),
    }).pipe(
      Effect.flatMap((res) => {
        if (res.status === 206 || res.status === 200) {
          onSuccess();
          return Effect.succeed(res);
        }
        const retryable = RETRYABLE_STATUSES.has(res.status);
        const retryAfterMs = RETRY_AFTER_STATUSES.has(res.status)
          ? parseRetryAfterMs(res.headers.get('retry-after'))
          : undefined;
        const fail = Effect.fail(
          new RangeFetchError(
            `Source did not honour the byte-range request (status ${res.status}); the URL must support HTTP range requests`,
            undefined,
            { retryable, retryAfterMs },
          ),
        );
        // Honour a server-requested cooldown as a FLOOR before the next retry:
        // sleep it, then fail so the schedule's own backoff applies on top.
        return retryAfterMs !== undefined
          ? Effect.zipRight(Effect.sleep(`${retryAfterMs} millis`), fail)
          : fail;
      }),
    );

  /** Apply the shared backoff policy, retrying only while the error is retryable. */
  const withRetry = <A>(effect: Effect.Effect<A, RangeFetchError>) =>
    effect.pipe(
      Effect.retry({ schedule: rangeRetrySchedule, while: (e: RangeFetchError) => e.retryable }),
    );

  const fetchRange = (range: ByteRange) =>
    withRetry(
      fetchRangeOnce({ Range: `bytes=${range.start}-${range.end - 1}` }, () =>
        metrics?.range(range.start, range.end),
      ),
    );

  return Layer.succeed(Source, {
    size: Effect.gen(function* () {
      // The size probe is a range request too — retry it on the same transient
      // failures (429/5xx/network) so a rate-limited probe doesn't fail the job.
      const res = yield* withRetry(fetchRangeOnce({ Range: 'bytes=0-0' }, () => {}));
      const contentRange = res.headers.get('content-range');
      // Format: "bytes 0-0/123456" — the part after the slash is the total.
      const total = contentRange?.split('/')[1];
      if (!total || total === '*' || Number.isNaN(Number(total))) {
        // Malformed Content-Range on an otherwise-OK response is PERMANENT —
        // retrying won't conjure a length. Fail fast (retryable defaults false).
        return yield* Effect.fail(
          new RangeFetchError(
            `Source did not return a usable Content-Range total size for ${sourceUrl}`,
          ),
        );
      }
      // The probe IS a 1-byte range request — count it honestly.
      metrics?.range(0, 1);
      metrics?.setArchiveSize(Number(total));
      return Number(total);
    }),

    readRange: (range) =>
      fetchRange(range).pipe(
        Effect.flatMap((res) =>
          Effect.tryPromise({
            try: async () => new Uint8Array(await res.arrayBuffer()),
            catch: (cause) => new RangeFetchError('Failed to read range response body', cause),
          }),
        ),
      ),

    streamRange: (range) =>
      fetchRange(range).pipe(
        Effect.flatMap((res) =>
          res.body
            ? Effect.succeed(res.body)
            : Effect.fail(new RangeFetchError('Range response had no body')),
        ),
      ),
  });
}

// -------------------------------------------------------------------------------------------------
// Bucket — R2 output
// -------------------------------------------------------------------------------------------------

/**
 * Opaque handle to an in-progress multipart upload. Each `Bucket` backend
 * stashes whatever it needs (the R2 `R2MultipartUpload` object, or a SigV4
 * upload-id) in `payload`; the extraction shell only ever passes it back.
 */
export interface MultipartHandle {
  readonly key: string;
  readonly payload: unknown;
}

/**
 * Opaque receipt for one uploaded part. `partNumber` is surfaced so the shell
 * can sort/sanity-check; `payload` carries the backend-specific completion data
 * (an `R2UploadedPart`, or an S3 ETag).
 */
export interface UploadedPart {
  readonly partNumber: number;
  readonly payload: unknown;
}

export class Bucket extends Context.Tag('Bucket')<
  Bucket,
  {
    /**
     * Stream an object into R2 at `key`. `size` is the EXACT uncompressed byte
     * length, which lets R2 store a precise Content-Length instead of buffering
     * to discover it.
     */
    readonly put: (
      key: string,
      body: ReadableStream<Uint8Array>,
      size: number,
    ) => Effect.Effect<void, R2WriteError>;

    /**
     * Begin a multipart upload at `key`. Used for large STORED entries so their
     * data can be range-fetched and uploaded as parts in parallel (a single
     * `put` is bound to one invocation's pump). Returns an opaque handle.
     */
    readonly createMultipart: (key: string) => Effect.Effect<MultipartHandle, R2WriteError>;

    /**
     * Upload one part. `body` is the streamed part range (never buffered beyond
     * what the part API needs); `size` is its exact byte length. Parts may be
     * uploaded concurrently and out of order — the `partNumber` orders them at
     * completion, not the call order.
     */
    readonly uploadPart: (
      handle: MultipartHandle,
      partNumber: number,
      body: ReadableStream<Uint8Array>,
      size: number,
    ) => Effect.Effect<UploadedPart, R2WriteError>;

    /** Finalise the multipart upload from its parts. `size` is the expected total. */
    readonly completeMultipart: (
      handle: MultipartHandle,
      parts: readonly UploadedPart[],
      size: number,
    ) => Effect.Effect<void, R2WriteError>;

    /** Best-effort abort of an in-progress multipart upload (cleanup on failure). */
    readonly abortMultipart: (handle: MultipartHandle) => Effect.Effect<void, never>;
  }
>() {}

/** R2-binding-backed `Bucket`. Records each successful write to the sink. */
export function makeR2Bucket(binding: R2Bucket, metrics?: MetricsSink): Layer.Layer<Bucket> {
  return Layer.succeed(Bucket, {
    put: (key, body, size) =>
      Effect.tryPromise({
        // The body is wired through a FixedLengthStream upstream, so R2 receives
        // a precise Content-Length and never buffers the object to size it.
        try: () => binding.put(key, body),
        catch: (cause) => new R2WriteError(`Failed to write "${key}" to R2`, cause),
      }).pipe(
        Effect.flatMap((object) =>
          object && object.size === size
            ? Effect.sync(() => metrics?.r2Write())
            : Effect.fail(
                new R2WriteError(
                  `R2 wrote "${key}" with size ${object?.size ?? 'unknown'}, expected ${size}`,
                ),
              ),
        ),
      ),

    createMultipart: (key) =>
      Effect.tryPromise({
        try: () => binding.createMultipartUpload(key),
        catch: (cause) => new R2WriteError(`Failed to start multipart upload for "${key}"`, cause),
      }).pipe(Effect.map((upload) => ({ key, payload: upload }))),

    uploadPart: (handle, partNumber, body, size) =>
      Effect.tryPromise({
        try: async () => {
          const upload = handle.payload as R2MultipartUpload;
          // Give R2 an exact part length without buffering the whole part: pipe
          // the part range through a FixedLengthStream sized to `size`, mirroring
          // the single-`put` path's memory discipline.
          const sized = new FixedLengthStream(size);
          const pumped = body.pipeTo(sized.writable);
          const uploaded = await upload.uploadPart(partNumber, sized.readable);
          await pumped;
          return uploaded;
        },
        catch: (cause) =>
          new R2WriteError(`Failed to upload part ${partNumber} of "${handle.key}" to R2`, cause),
      }).pipe(Effect.map((uploaded) => ({ partNumber, payload: uploaded }))),

    completeMultipart: (handle, parts, size) =>
      Effect.tryPromise({
        try: () => {
          const upload = handle.payload as R2MultipartUpload;
          const uploaded = parts.map((p) => p.payload as R2UploadedPart);
          return upload.complete(uploaded);
        },
        catch: (cause) =>
          new R2WriteError(`Failed to complete multipart upload of "${handle.key}"`, cause),
      }).pipe(
        Effect.flatMap((object) =>
          object.size === size
            ? Effect.sync(() => metrics?.r2Write())
            : Effect.fail(
                new R2WriteError(
                  `R2 completed "${handle.key}" with size ${object.size}, expected ${size}`,
                ),
              ),
        ),
      ),

    abortMultipart: (handle) =>
      Effect.promise(async () => {
        try {
          await (handle.payload as R2MultipartUpload).abort();
        } catch {
          // Best-effort cleanup — the original failure is what matters; R2 also
          // auto-aborts incomplete uploads after 7 days.
        }
      }),
  });
}

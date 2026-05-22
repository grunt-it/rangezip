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

import { Context, Effect, Layer } from 'effect';
import { R2WriteError, RangeFetchError } from './errors';
import type { MetricsSink } from './metrics-sink';

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
  const fetchRange = (range: ByteRange) =>
    Effect.tryPromise({
      try: () =>
        fetch(sourceUrl, {
          headers: { Range: `bytes=${range.start}-${range.end - 1}` },
        }),
      catch: (cause) =>
        new RangeFetchError(`Network error fetching range from ${sourceUrl}`, cause),
    }).pipe(
      Effect.filterOrFail(
        (res) => res.status === 206 || res.status === 200,
        (res) =>
          new RangeFetchError(
            `Source did not honour the byte-range request (status ${res.status}); the URL must support HTTP range requests`,
          ),
      ),
      Effect.tap(() => Effect.sync(() => metrics?.range(range.start, range.end))),
    );

  return Layer.succeed(Source, {
    size: Effect.gen(function* () {
      const res = yield* Effect.tryPromise({
        try: () => fetch(sourceUrl, { headers: { Range: 'bytes=0-0' } }),
        catch: (cause) => new RangeFetchError(`Network error probing size of ${sourceUrl}`, cause),
      });
      const contentRange = res.headers.get('content-range');
      // Format: "bytes 0-0/123456" — the part after the slash is the total.
      const total = contentRange?.split('/')[1];
      if (!total || total === '*' || Number.isNaN(Number(total))) {
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

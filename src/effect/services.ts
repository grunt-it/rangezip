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
 */
export function makeHttpSource(sourceUrl: string): Layer.Layer<Source> {
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
  }
>() {}

/** R2-binding-backed `Bucket`. */
export function makeR2Bucket(binding: R2Bucket): Layer.Layer<Bucket> {
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
            ? Effect.void
            : Effect.fail(
                new R2WriteError(
                  `R2 wrote "${key}" with size ${object?.size ?? 'unknown'}, expected ${size}`,
                ),
              ),
        ),
      ),
  });
}

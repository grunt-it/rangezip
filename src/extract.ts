/**
 * The extraction logic: the Effect shell that wires the pure ZIP parsers
 * (`./zip`) to the `Source` (range reads) and `Bucket` (R2) services.
 *
 * Two operations:
 *   - `readIndex`   — locate + parse the central directory without downloading
 *                     the archive (tail read → CD read → parse).
 *   - `extractEntry`— pull ONE entry's bytes out and stream them into R2.
 *
 * Memory discipline (the whole point): we never hold more than one byte-range
 * slice in memory. The index reads are tiny (tail + CD). The per-file data is
 * streamed: range-GET → `DecompressionStream` → `FixedLengthStream` → R2.put.
 * Nothing materialises the (possibly multi-GB) entry in the isolate.
 */

import { Effect } from 'effect';
import { DecompressError, R2WriteError, ZipParseError } from './effect/errors';
import { Bucket, Source, type MultipartHandle, type UploadedPart } from './effect/services';
import type { MetricsSink } from './effect/metrics-sink';
import {
  ByteReader,
  CompressionMethod,
  computeDataOffset,
  locateCentralDirectory,
  parseCentralDirectory,
  planMultipartParts,
  type PartPlan,
  type ZipEntry,
} from './zip';

/** How many bytes to range-GET from the tail on the first index read. */
const INITIAL_TAIL_BYTES = 64 * 1024;
/** Upper bound on tail growth — the EOCD comment field maxes out at 64 KB, so
 *  ~128 KB always covers EOCD + ZIP64 records + a maximal comment. */
const MAX_TAIL_BYTES = 128 * 1024;
/** Fixed size of a local file header (before its variable name/extra fields). */
const LOCAL_HEADER_FIXED_BYTES = 30;

/**
 * STORED entries at or above this size take the parallel multipart path instead
 * of a single streamed `put`. Below it, a single put is simpler and well within
 * one invocation's reach. 64 MiB is comfortably above R2's 5 MiB part floor so
 * even a just-over-threshold entry yields a clean two-part plan.
 */
export const DEFAULT_MULTIPART_THRESHOLD = 64 * 1024 * 1024;
/** Target size of each multipart part. Every part but the last is exactly this. */
export const DEFAULT_PART_SIZE = 64 * 1024 * 1024;
/**
 * Default cap on how many parts of ONE entry upload at once. Mirrors the DO's
 * per-file concurrency cap so a single large entry's part fan-out doesn't open
 * more simultaneous range reads than the many-file path already bounds.
 */
export const DEFAULT_PART_CONCURRENCY = 6;

/** Tunables for {@link extractEntry}. Injectable so tests can lower the threshold. */
export interface ExtractOptions {
  /** STORED entries `>=` this many bytes use the multipart path. */
  readonly multipartThreshold?: number;
  /** Part size for the multipart path (every part but the last is exactly this). */
  readonly partSize?: number;
  /** Max parts uploaded concurrently for one entry. */
  readonly partConcurrency?: number;
}

// -------------------------------------------------------------------------------------------------
// readIndex — list every entry, no full download
// -------------------------------------------------------------------------------------------------

/**
 * Read and parse the central directory, returning every entry. Grows the tail
 * read once if the EOCD/ZIP64 records don't fit in the initial window.
 */
export function readIndex(
  metrics?: MetricsSink,
): Effect.Effect<
  readonly ZipEntry[],
  ZipParseError | import('./effect/errors').RangeFetchError,
  Source
> {
  return Effect.gen(function* () {
    const source = yield* Source;
    const totalSize = yield* source.size;

    const location = yield* locateWithGrowingTail(totalSize, INITIAL_TAIL_BYTES);

    const cdBytes = yield* source.readRange({
      start: location.offset,
      end: location.offset + location.size,
    });
    // The central directory is read exactly ONCE here, then reused for every
    // file extraction in the job — a real reuse metric, not an invented one.
    metrics?.centralDirectoryRead();

    const parsed = parseCentralDirectory(cdBytes, location.entryCount);
    if (!parsed.ok) {
      return yield* Effect.fail(new ZipParseError(parsed.reason));
    }
    return parsed.entries;
  });
}

/**
 * Locate the central directory, retrying with a larger tail if the first read
 * didn't capture the ZIP64 records (the only legitimate "grow" case).
 */
function locateWithGrowingTail(
  totalSize: number,
  tailBytes: number,
): Effect.Effect<
  import('./zip').CentralDirectoryLocation,
  ZipParseError | import('./effect/errors').RangeFetchError,
  Source
> {
  return Effect.gen(function* () {
    const source = yield* Source;
    const start = Math.max(0, totalSize - tailBytes);
    const tail = yield* source.readRange({ start, end: totalSize });

    const result = locateCentralDirectory(new ByteReader(tail), start);
    if (result.ok) return result.location;

    const canGrow = start > 0 && tailBytes < MAX_TAIL_BYTES;
    if (canGrow) {
      return yield* locateWithGrowingTail(totalSize, Math.min(tailBytes * 2, MAX_TAIL_BYTES));
    }
    return yield* Effect.fail(new ZipParseError(result.reason));
  });
}

// -------------------------------------------------------------------------------------------------
// extractEntry — pull one file out and stream it into R2
// -------------------------------------------------------------------------------------------------

/** Result of extracting one entry. */
export interface ExtractedEntry {
  readonly name: string;
  readonly key: string;
  readonly bytesWritten: number;
}

/** The full error channel of an extraction. */
type ExtractError =
  | ZipParseError
  | DecompressError
  | import('./effect/errors').RangeFetchError
  | R2WriteError;

/**
 * Extract a single entry and stream it to `${prefix}/${entry.name}` in R2.
 *
 *   1. Range-GET the 30-byte local header to compute the true data offset
 *      (the local header's own name/extra lengths differ from the CD's).
 *   2. Choose a path:
 *      - Large STORED entry (`>= multipartThreshold`): split the data range into
 *        parts, range-GET each in parallel (bounded), and `uploadPart` them into
 *        an R2 multipart upload, then complete it. No decompression — STORED
 *        bytes ARE the file, so the range is freely splittable.
 *      - Everything else (DEFLATE, or small STORED): the single streamed path —
 *        range-GET → (inflate if DEFLATE) → FixedLengthStream → one `put`. A
 *        deflate stream isn't randomly seekable, so it can't be split.
 */
export function extractEntry(
  entry: ZipEntry,
  prefix: string,
  metrics?: MetricsSink,
  options: ExtractOptions = {},
): Effect.Effect<ExtractedEntry, ExtractError, Source | Bucket> {
  return Effect.gen(function* () {
    const source = yield* Source;

    // 1. Local header → exact data offset.
    const localHeaderBytes = yield* source.readRange({
      start: entry.localHeaderOffset,
      end: entry.localHeaderOffset + LOCAL_HEADER_FIXED_BYTES,
    });
    const offsetResult = computeDataOffset(
      new ByteReader(localHeaderBytes),
      entry.localHeaderOffset,
    );
    if (!offsetResult.ok) {
      return yield* Effect.fail(new ZipParseError(offsetResult.reason));
    }
    const dataOffset = offsetResult.dataOffset;
    const key = joinKey(prefix, entry.name);

    const threshold = options.multipartThreshold ?? DEFAULT_MULTIPART_THRESHOLD;
    const isLargeStored =
      entry.compressionMethod === CompressionMethod.STORED && entry.uncompressedSize >= threshold;

    if (isLargeStored) {
      yield* extractStoredMultipart(entry, key, dataOffset, options);
    } else {
      yield* extractSingleStream(entry, key, dataOffset, metrics);
    }

    metrics?.fileExtracted();
    return { name: entry.name, key, bytesWritten: entry.uncompressedSize };
  });
}

/**
 * The single-stream path: range-GET the (compressed) bytes, inflate if DEFLATE,
 * size with a FixedLengthStream, and `put` once. Used for DEFLATE entries (a
 * deflate stream can't be split) and for small STORED entries.
 */
function extractSingleStream(
  entry: ZipEntry,
  key: string,
  dataOffset: number,
  metrics?: MetricsSink,
): Effect.Effect<void, ExtractError, Source | Bucket> {
  return Effect.gen(function* () {
    const source = yield* Source;
    const bucket = yield* Bucket;

    const compressed = yield* source.streamRange({
      start: dataOffset,
      end: dataOffset + entry.compressedSize,
    });

    const decompressed =
      entry.compressionMethod === CompressionMethod.DEFLATE
        ? compressed.pipeThrough(new DecompressionStream('deflate-raw'))
        : compressed;

    // FixedLengthStream gives R2 an exact Content-Length and turns a
    // truncated/corrupt inflate into a write-time error instead of a silent
    // short object.
    const sized = new FixedLengthStream(entry.uncompressedSize);
    const pump = Effect.tryPromise({
      // Measure wallclock around the decompress+stream pump. This is the
      // CPU-bound inflate section (plus the stream plumbing) — recorded as a
      // MEASURED time delta, never represented as billed CPU-ms.
      try: async () => {
        const startedAt = performance.now();
        try {
          return await decompressed.pipeTo(sized.writable);
        } finally {
          metrics?.compute(performance.now() - startedAt);
        }
      },
      catch: (cause) =>
        new DecompressError(
          `Failed to decompress/stream "${entry.name}" (method ${entry.compressionMethod})`,
          cause,
        ),
    });

    // Run the pump and the R2 write concurrently — the pump feeds the writable
    // while R2 drains the readable; they must overlap.
    yield* Effect.all([pump, bucket.put(key, sized.readable, entry.uncompressedSize)], {
      concurrency: 'unbounded',
    });
  });
}

/**
 * The parallel multipart path for a large STORED entry. STORED bytes need no
 * decompression, so the data range `[dataOffset, dataOffset + size)` splits
 * cleanly: plan the parts (pure), then range-GET + `uploadPart` each in parallel
 * with bounded concurrency, and complete the upload. Each part is STREAMED into
 * its `uploadPart` — never buffered whole. On any failure the upload is aborted.
 */
function extractStoredMultipart(
  entry: ZipEntry,
  key: string,
  dataOffset: number,
  options: ExtractOptions,
): Effect.Effect<void, ExtractError, Source | Bucket> {
  return Effect.gen(function* () {
    const bucket = yield* Bucket;

    const partSize = options.partSize ?? DEFAULT_PART_SIZE;
    const concurrency = options.partConcurrency ?? DEFAULT_PART_CONCURRENCY;

    // For STORED, compressedSize === uncompressedSize; plan over the real size.
    const plan = planMultipartParts(dataOffset, entry.uncompressedSize, partSize);
    if (!plan.ok) {
      return yield* Effect.fail(
        new R2WriteError(`Could not plan multipart upload for "${entry.name}": ${plan.reason}`),
      );
    }

    const handle = yield* bucket.createMultipart(key);

    // Upload each part in parallel (bounded), aborting the whole upload if any
    // part fails — then re-fail with the original error.
    const parts = yield* Effect.all(
      plan.parts.map((part) => uploadOnePart(handle, part)),
      {
        concurrency,
      },
    ).pipe(Effect.tapError(() => bucket.abortMultipart(handle)));

    yield* bucket
      .completeMultipart(handle, parts, entry.uncompressedSize)
      .pipe(Effect.tapError(() => bucket.abortMultipart(handle)));
  });
}

/** Range-GET one planned part and stream it into `uploadPart`. */
function uploadOnePart(
  handle: MultipartHandle,
  part: PartPlan,
): Effect.Effect<UploadedPart, ExtractError, Source | Bucket> {
  return Effect.gen(function* () {
    const source = yield* Source;
    const bucket = yield* Bucket;
    const body = yield* source.streamRange({
      start: part.offset,
      end: part.offset + part.length,
    });
    return yield* bucket.uploadPart(handle, part.partNumber, body, part.length);
  });
}

/** Join a prefix and an entry name into an R2 key without doubling slashes. */
export function joinKey(prefix: string, name: string): string {
  const cleanPrefix = prefix.replace(/\/+$/, '');
  const cleanName = name.replace(/^\/+/, '');
  return cleanPrefix ? `${cleanPrefix}/${cleanName}` : cleanName;
}

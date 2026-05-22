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
import { DecompressError, ZipParseError } from './effect/errors';
import { Bucket, Source } from './effect/services';
import type { MetricsSink } from './effect/metrics-sink';
import {
  ByteReader,
  CompressionMethod,
  computeDataOffset,
  locateCentralDirectory,
  parseCentralDirectory,
  type ZipEntry,
} from './zip';

/** How many bytes to range-GET from the tail on the first index read. */
const INITIAL_TAIL_BYTES = 64 * 1024;
/** Upper bound on tail growth — the EOCD comment field maxes out at 64 KB, so
 *  ~128 KB always covers EOCD + ZIP64 records + a maximal comment. */
const MAX_TAIL_BYTES = 128 * 1024;
/** Fixed size of a local file header (before its variable name/extra fields). */
const LOCAL_HEADER_FIXED_BYTES = 30;

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

/**
 * Extract a single entry and stream it to `${prefix}/${entry.name}` in R2.
 *
 * Steps:
 *   1. Range-GET the 30-byte local header to compute the true data offset
 *      (the local header's own name/extra lengths differ from the CD's).
 *   2. Range-GET the compressed bytes as a stream.
 *   3. STORED → pass through; DEFLATE → pipe through DecompressionStream.
 *   4. Wrap in a FixedLengthStream sized to the uncompressed length so R2 gets
 *      an exact Content-Length and we assert the produced byte count.
 *   5. R2.put the readable side.
 */
export function extractEntry(
  entry: ZipEntry,
  prefix: string,
  metrics?: MetricsSink,
): Effect.Effect<
  ExtractedEntry,
  | ZipParseError
  | DecompressError
  | import('./effect/errors').RangeFetchError
  | import('./effect/errors').R2WriteError,
  Source | Bucket
> {
  return Effect.gen(function* () {
    const source = yield* Source;
    const bucket = yield* Bucket;

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

    // 2. Compressed bytes as a stream (never fully buffered).
    const compressed = yield* source.streamRange({
      start: dataOffset,
      end: dataOffset + entry.compressedSize,
    });

    // 3. Decompress according to method.
    const decompressed =
      entry.compressionMethod === CompressionMethod.DEFLATE
        ? compressed.pipeThrough(new DecompressionStream('deflate-raw'))
        : compressed;

    // 4. FixedLengthStream gives R2 an exact Content-Length and turns a
    //    truncated/corrupt inflate into a write-time error instead of a silent
    //    short object.
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

    const key = joinKey(prefix, entry.name);

    // 5. Run the pump and the R2 write concurrently — the pump feeds the
    //    writable while R2 drains the readable; they must overlap.
    yield* Effect.all([pump, bucket.put(key, sized.readable, entry.uncompressedSize)], {
      concurrency: 'unbounded',
    });

    metrics?.fileExtracted();
    return { name: entry.name, key, bytesWritten: entry.uncompressedSize };
  });
}

/** Join a prefix and an entry name into an R2 key without doubling slashes. */
export function joinKey(prefix: string, name: string): string {
  const cleanPrefix = prefix.replace(/\/+$/, '');
  const cleanName = name.replace(/^\/+/, '');
  return cleanPrefix ? `${cleanPrefix}/${cleanName}` : cleanName;
}

/**
 * Pure sharding logic — split the selected ZIP entries across N extraction
 * workers so the fan-out balances WORK, not just file count.
 *
 * Why this is the heart of the parallel re-architecture: Cloudflare caps each
 * Worker/DO *invocation* at 6 simultaneous open connections. Running the whole
 * extraction inside one coordinator DO pins peak concurrency at 6. By splitting
 * the entries into shards and handing each shard to its own `ExtractWorker` DO
 * (its own isolate, its own 6-connection budget), effective concurrency becomes
 * `N × 6`. The catch: a naive round-robin or count-based split can pile every
 * large entry onto one worker, so that worker becomes the long pole while the
 * others idle. We balance by *bytes* instead.
 *
 * No IO, no Effect, no runtime — just arithmetic over the parsed entries, so the
 * balancing is trivially unit-testable (`test/shard.test.ts`).
 */

import type { ZipEntry } from './zip';

/** A single worker's slice of the job: the entries it will extract. */
export interface Shard {
  /** Zero-based worker index; becomes part of the worker DO name `${jobId}:w${i}`. */
  readonly index: number;
  /** The entries assigned to this worker, in descending-size order. */
  readonly entries: readonly ZipEntry[];
  /** Sum of `uncompressedSize` over `entries` — the worker's planned byte load. */
  readonly totalBytes: number;
}

/** Tunables for {@link shardEntries}. */
export interface ShardOptions {
  /**
   * Hard ceiling on the number of worker DOs spawned for one job. Caps the
   * source-side fan-out (`MAX_WORKERS × 6` simultaneous range reads) so we get
   * strong parallelism without hammering the origin into rate-limits.
   */
  readonly maxWorkers: number;
  /**
   * Target number of files per worker. The worker count scales with the file
   * count up to `maxWorkers`: `ceil(fileCount / filesPerWorker)`. Keeps tiny
   * jobs from spinning up the full fleet (one worker for a handful of files).
   */
  readonly filesPerWorker: number;
}

/** Sensible defaults. `maxWorkers × 6` ≈ 384 effective concurrency at the cap.
 * 64 is the sweet spot: beyond it, typical archives (~500 files) starve each
 * worker's 6-connection pool (too few files/worker), so aggregate concurrency
 * DROPS and spawn overhead grows — measured 768-way as slower than 384-way. */
export const DEFAULT_MAX_WORKERS = 64;
export const DEFAULT_FILES_PER_WORKER = 4;

/**
 * Choose how many workers to spawn for a job of `fileCount` files. Scales with
 * the work but never exceeds `maxWorkers`, and is always ≥ 1 when there's at
 * least one file (0 files ⇒ 0 workers — nothing to do).
 *
 * Pure: same inputs → same output.
 */
export function chooseWorkerCount(
  fileCount: number,
  options: ShardOptions = {
    maxWorkers: DEFAULT_MAX_WORKERS,
    filesPerWorker: DEFAULT_FILES_PER_WORKER,
  },
): number {
  if (fileCount <= 0) return 0;
  const byLoad = Math.ceil(fileCount / Math.max(1, options.filesPerWorker));
  return Math.max(1, Math.min(options.maxWorkers, byLoad));
}

/**
 * Split `entries` into balanced shards using the greedy
 * longest-processing-time-first (LPT) heuristic: sort the entries largest-first,
 * then drop each into whichever shard currently holds the fewest bytes. This is
 * the classic multiprocessor-scheduling approximation — it keeps the heaviest
 * shard close to the average, so no single worker becomes the long pole because
 * all the big PNGs landed on it.
 *
 * Guarantees (asserted by the unit tests):
 *   - Every input entry appears in EXACTLY ONE shard (no drops, no dupes).
 *   - The number of shards is `chooseWorkerCount(entries.length, options)`,
 *     except it never exceeds the number of entries (no empty shards).
 *   - Shard byte totals are within one max-entry of each other (LPT bound).
 *
 * Pure: no IO. Ties (equal byte load) break toward the lowest shard index, so
 * the output is deterministic for a given input.
 */
export function shardEntries(
  entries: readonly ZipEntry[],
  options: ShardOptions = {
    maxWorkers: DEFAULT_MAX_WORKERS,
    filesPerWorker: DEFAULT_FILES_PER_WORKER,
  },
): Shard[] {
  const workerCount = Math.min(chooseWorkerCount(entries.length, options), entries.length);
  if (workerCount <= 0) return [];

  // Mutable accumulators, one per shard. Sort a COPY largest-first so the
  // original ordering isn't mutated and the LPT bound holds.
  const buckets: { index: number; entries: ZipEntry[]; totalBytes: number }[] = Array.from(
    { length: workerCount },
    (_unused, index) => ({ index, entries: [], totalBytes: 0 }),
  );

  const bySizeDesc = [...entries].sort((a, b) => b.uncompressedSize - a.uncompressedSize);

  for (const entry of bySizeDesc) {
    // Find the currently-lightest bucket (ties → lowest index, the natural
    // first-min of a forward scan). For small N this linear scan is cheap and
    // keeps the heuristic exact rather than approximating with a heap.
    let lightest = buckets[0]!;
    for (const bucket of buckets) {
      if (bucket.totalBytes < lightest.totalBytes) lightest = bucket;
    }
    lightest.entries.push(entry);
    lightest.totalBytes += entry.uncompressedSize;
  }

  return buckets.map((bucket) => ({
    index: bucket.index,
    entries: bucket.entries,
    totalBytes: bucket.totalBytes,
  }));
}

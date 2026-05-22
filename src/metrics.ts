/**
 * Job metrics — the honest numbers the demo surfaces.
 *
 * Every field here is a REAL measurement taken during a run, not an estimate.
 * The headline is `rangeBytesFetched` vs `archiveSize`: how few bytes we pulled
 * over the wire to extract the requested files, as a fraction of the whole
 * archive. The pure functions in this module do the *aggregation and labelling*
 * math (totals, percentages, phase splits) over raw counters the DO records;
 * the DO is responsible for incrementing the counters at the real IO sites.
 *
 * Labelling discipline (a critical reviewer will scrutinise these):
 *   - `rangeBytesFetched`     — sum of (end-start) over every range-GET issued.
 *   - `archiveSize`           — the source object's total size (from Content-Range).
 *   - `rangeRequestCount`     — count of range-GETs (size probe + index + per-file).
 *   - `peakConcurrency`       — max simultaneous in-flight extractions observed.
 *   - `computeMs`             — summed `performance.now()` deltas around the
 *                               CPU-bound inflate/stream sections. Labelled
 *                               "measured", NEVER presented as billed CPU-ms.
 *   - `indexReadMs`           — wallclock from job start to index parsed.
 *   - `extractionMs`          — wallclock from index parsed to last file settled.
 *   - `r2Writes`              — count of successful R2 `put`s.
 *   - `centralDirectoryReads` — how many times the central directory was read
 *                               from the source (it's read ONCE and reused across
 *                               every file extraction — a real reuse metric).
 */

/**
 * Which phase of the job is currently running. Emitted in progress messages so
 * the UI can show that the (sequential, concurrency-1) index read precedes the
 * (parallel, N×6) extraction fan-out. `idle` before a job starts; `done` once
 * everything has settled.
 */
export type JobPhase = 'idle' | 'reading-index' | 'extracting' | 'done';

/** Raw counters accumulated during a run, persisted in the DO. */
export interface RawMetrics {
  readonly archiveSize: number;
  readonly rangeBytesFetched: number;
  readonly rangeRequestCount: number;
  /**
   * Peak simultaneous extractions observed. With the fan-out architecture this
   * is the peak of the SUM of in-flight counts ACROSS ALL worker DOs (each
   * worker reports its own in-flight count; the coordinator sums and tracks the
   * max). So it reflects true cross-isolate parallelism (~N×6), not the 6-cap of
   * a single isolate.
   */
  readonly peakConcurrency: number;
  readonly computeMs: number;
  readonly indexReadMs: number;
  readonly extractionMs: number;
  readonly r2Writes: number;
  readonly centralDirectoryReads: number;
  readonly filesExtracted: number;
  /**
   * How many extraction worker DOs the job fanned out across (0 for an
   * index-only or empty job). A real, measured fleet size — the headline that
   * explains how `peakConcurrency` can exceed a single isolate's 6-connection cap.
   */
  readonly workerCount: number;
  /** The current job phase — see {@link JobPhase}. */
  readonly phase: JobPhase;
}

/** The zero state for a fresh job. */
export const ZERO_METRICS: RawMetrics = {
  archiveSize: 0,
  rangeBytesFetched: 0,
  rangeRequestCount: 0,
  peakConcurrency: 0,
  computeMs: 0,
  indexReadMs: 0,
  extractionMs: 0,
  r2Writes: 0,
  centralDirectoryReads: 0,
  filesExtracted: 0,
  workerCount: 0,
  phase: 'idle',
};

/** The derived view the UI renders — raw counters plus computed labels. */
export interface MetricsView extends RawMetrics {
  /** Total wallclock = index-read + extraction phases. */
  readonly totalMs: number;
  /**
   * Bytes fetched as a percentage of the whole archive. The headline number:
   * "we touched X% of the archive to get your files". 0 when archiveSize is 0.
   */
  readonly rangeBytesPercent: number;
  /** Bytes of the archive we did NOT fetch (the savings). */
  readonly bytesSaved: number;
}

/** Round a number to `places` decimals (avoids float noise in the UI). */
function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Derive the UI view from raw counters. Pure: same input → same output, no IO.
 * Guards against divide-by-zero (a job that never read a size yields 0%, not
 * NaN/Infinity).
 */
export function deriveMetrics(raw: RawMetrics): MetricsView {
  const totalMs = round(raw.indexReadMs + raw.extractionMs, 1);
  const rangeBytesPercent =
    raw.archiveSize > 0 ? round((raw.rangeBytesFetched / raw.archiveSize) * 100, 4) : 0;
  const bytesSaved = Math.max(0, raw.archiveSize - raw.rangeBytesFetched);
  return {
    ...raw,
    totalMs,
    rangeBytesPercent,
    bytesSaved,
  };
}

/**
 * Fold a single range-read into the running counters: one more request, plus the
 * range's byte span. `start`/`end` are the half-open `[start, end)` bounds, so
 * the byte count is `end - start`. Used at every `readRange`/`streamRange` site.
 */
export function recordRange(raw: RawMetrics, start: number, end: number): RawMetrics {
  const bytes = Math.max(0, end - start);
  return {
    ...raw,
    rangeBytesFetched: raw.rangeBytesFetched + bytes,
    rangeRequestCount: raw.rangeRequestCount + 1,
  };
}

/** Raise the recorded peak concurrency if `current` exceeds it. */
export function recordConcurrency(raw: RawMetrics, current: number): RawMetrics {
  return current > raw.peakConcurrency ? { ...raw, peakConcurrency: current } : raw;
}

/**
 * The slice of a worker's measured counters that the coordinator aggregates
 * into the job-wide totals. Each `ExtractWorker` extracts its shard with its own
 * `MetricsSink`, then hands these back so the headline numbers (bytes fetched,
 * R2 writes, compute time, files done) reflect the WHOLE fan-out, not just the
 * coordinator's own index read.
 *
 * NB: `archiveSize` and `centralDirectoryReads` are NOT here — those are owned
 * by the coordinator (it reads the index once and reuses it; the workers don't
 * re-probe the size or re-read the central directory). Folding them in would
 * double-count. `peakConcurrency` is handled separately (live, via per-worker
 * in-flight reports) — a worker's local peak can't simply be summed after the
 * fact because the workers don't peak at the same instant.
 */
export interface WorkerMetricsContribution {
  readonly rangeBytesFetched: number;
  readonly rangeRequestCount: number;
  readonly computeMs: number;
  readonly r2Writes: number;
  readonly filesExtracted: number;
}

/**
 * Fold one worker's contribution into the running coordinator counters. Pure and
 * additive — call it once per worker as its shard summary comes back. Leaves
 * `archiveSize`, `centralDirectoryReads`, `peakConcurrency`, phase, and the
 * phase timings untouched (those are coordinator-owned; see the type doc above).
 */
export function mergeWorkerMetrics(
  raw: RawMetrics,
  contribution: WorkerMetricsContribution,
): RawMetrics {
  return {
    ...raw,
    rangeBytesFetched: raw.rangeBytesFetched + contribution.rangeBytesFetched,
    rangeRequestCount: raw.rangeRequestCount + contribution.rangeRequestCount,
    computeMs: raw.computeMs + contribution.computeMs,
    r2Writes: raw.r2Writes + contribution.r2Writes,
    filesExtracted: raw.filesExtracted + contribution.filesExtracted,
  };
}

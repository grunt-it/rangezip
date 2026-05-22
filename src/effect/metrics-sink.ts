/**
 * A mutable metrics sink threaded through the IO services.
 *
 * The pure aggregation/labelling math lives in `../metrics`; this is the small
 * stateful collector the Effect services (`Source` range reads, `Bucket` R2
 * writes) and the DO (concurrency, phase timings, compute time) increment as
 * real IO happens. Keeping it a plain object (not an Effect service tag) means
 * the extraction Effects keep their existing signatures — the sink is injected
 * at layer-construction time alongside the binding, exactly where the IO occurs.
 *
 * Every increment here corresponds to a REAL event:
 *   - `range(start, end)` is called once per actual range-GET, with the actual
 *     byte span — so `rangeBytesFetched` is bytes truly pulled over the wire.
 *   - `r2Write()` once per successful R2 `put`.
 *   - `compute(ms)` adds a measured `performance.now()` delta.
 *
 * It deliberately exposes mutation methods rather than letting callers poke the
 * fields, so the recording sites read clearly and the "this is measured" intent
 * is explicit.
 */

import {
  mergeWorkerMetrics,
  recordConcurrency,
  recordRange,
  ZERO_METRICS,
  type JobPhase,
  type RawMetrics,
  type WorkerMetricsContribution,
} from '../metrics';

export class MetricsSink {
  private raw: RawMetrics = { ...ZERO_METRICS };

  /** Record the archive's total size (from the source size probe). */
  setArchiveSize(size: number): void {
    this.raw = { ...this.raw, archiveSize: size };
  }

  /** Record one range-GET of `[start, end)`. Increments count + byte total. */
  range(start: number, end: number): void {
    this.raw = recordRange(this.raw, start, end);
  }

  /** Record that the central directory was read once (reused thereafter). */
  centralDirectoryRead(): void {
    this.raw = { ...this.raw, centralDirectoryReads: this.raw.centralDirectoryReads + 1 };
  }

  /** Record one successful R2 write. */
  r2Write(): void {
    this.raw = { ...this.raw, r2Writes: this.raw.r2Writes + 1 };
  }

  /** Record one file successfully extracted. */
  fileExtracted(): void {
    this.raw = { ...this.raw, filesExtracted: this.raw.filesExtracted + 1 };
  }

  /** Add a measured compute-time delta (ms), summed across inflate sections. */
  compute(ms: number): void {
    this.raw = { ...this.raw, computeMs: this.raw.computeMs + ms };
  }

  /** Observe the current in-flight extraction count; raises the peak. */
  observeConcurrency(current: number): void {
    this.raw = recordConcurrency(this.raw, current);
  }

  /** Set the index-read phase wallclock (ms). */
  setIndexReadMs(ms: number): void {
    this.raw = { ...this.raw, indexReadMs: ms };
  }

  /** Set the extraction-phase wallclock (ms). */
  setExtractionMs(ms: number): void {
    this.raw = { ...this.raw, extractionMs: ms };
  }

  /** Set the current job phase (idle → reading-index → extracting → done). */
  setPhase(phase: JobPhase): void {
    this.raw = { ...this.raw, phase };
  }

  /** Record how many extraction worker DOs the job fanned out across. */
  setWorkerCount(count: number): void {
    this.raw = { ...this.raw, workerCount: count };
  }

  /**
   * Fold one worker DO's measured contribution into the job-wide counters
   * (bytes fetched, requests, compute, R2 writes, files). Used by the
   * coordinator as each shard's summary returns — see {@link mergeWorkerMetrics}.
   */
  mergeWorker(contribution: WorkerMetricsContribution): void {
    this.raw = mergeWorkerMetrics(this.raw, contribution);
  }

  /** Snapshot the current raw counters (immutable copy). */
  snapshot(): RawMetrics {
    return { ...this.raw };
  }
}

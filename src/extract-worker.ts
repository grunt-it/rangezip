/**
 * The `ExtractWorker` Durable Object — one instance per SHARD of a job.
 *
 * This is the unit of real parallelism. Cloudflare caps each Worker/DO
 * *invocation* at 6 simultaneous open connections, so running an entire
 * extraction inside the single coordinator DO pins peak concurrency at 6. The
 * coordinator instead splits the selected entries into shards (balanced by
 * bytes — see `src/shard.ts`) and hands each shard to its own `ExtractWorker`.
 * Every worker is a separate isolate with its OWN 6-connection budget, CPU, and
 * memory, so effective concurrency across the fleet is `N × 6`.
 *
 * Each worker:
 *   - Builds its own Effect runtime (HTTP `Source` over the same source URL +
 *     the `Bucket` — demo R2 or a SigV4 BYO bucket), wired to its own
 *     `MetricsSink`.
 *   - Extracts its shard with an internal bounded pool of {@link WORKER_CONCURRENCY}
 *     (the per-isolate connection limit), reusing the existing `extractEntry`
 *     streaming logic — range → DecompressionStream/stored → FixedLengthStream
 *     → R2, never buffering a whole file.
 *   - Reports each file's status transition back to the coordinator over RPC
 *     (`coordinator.reportFileResult(...)`), carrying its CURRENT in-flight
 *     count so the coordinator can track the live cross-worker peak concurrency.
 *   - Returns a shard summary (measured counters) so the coordinator can fold
 *     the worker's bytes/compute/R2-writes into the job-wide headline metrics.
 *
 * The worker holds NO durable state of its own — it's a stateless compute fan-
 * out unit. All authoritative state (the `file` table, aggregated metrics) lives
 * in the coordinator's SQLite. So `ExtractWorker` needs no SQLite class (it uses
 * the `new_classes` migration form, not `new_sqlite_classes`).
 *
 * BYO credentials are TRANSIENT here too: passed in the shard input for the run,
 * used to build the bucket, never persisted or logged.
 */

import { DurableObject } from 'cloudflare:workers';
import { extractEntry } from './extract';
import { makeRuntime, run, type AppRuntime } from './effect/runtime';
import { MetricsSink } from './effect/metrics-sink';
import { makeByoBucket, type ByoConfig } from './destination';
import { Layer, ManagedRuntime } from 'effect';
import { makeHttpSource } from './effect/services';
import type { WorkerMetricsContribution } from './metrics';
import type { ExtractJob, FileStatus } from './job';
import type { ZipEntry } from './zip';

/** Bindings the worker needs: the demo output bucket + the coordinator namespace. */
export interface ExtractWorkerEnv {
  OUTPUT: R2Bucket;
  /** The coordinator DO namespace — for reporting per-file results back by jobId. */
  EXTRACT_JOB: DurableObjectNamespace<ExtractJob>;
}

/**
 * The per-isolate concurrency cap. Cloudflare allows at most 6 simultaneous open
 * connections per invocation; we run the shard's extractions through a pool of
 * exactly this size so each worker saturates its own budget without exceeding it.
 */
export const WORKER_CONCURRENCY = 6;

/**
 * The minimal coordinator surface a worker calls back into. Declared structurally
 * (not as the full `ExtractJob` type) to keep the worker decoupled from the
 * coordinator's internals — the binding stub satisfies it.
 */
export interface CoordinatorStub {
  /** Report one file's status transition, plus this worker's live in-flight count. */
  reportFileResult(report: FileReport): Promise<void>;
}

/** A single file's status transition reported from a worker to the coordinator. */
export interface FileReport {
  /** Which worker (shard index) is reporting — keys the coordinator's in-flight map. */
  readonly workerIndex: number;
  readonly name: string;
  readonly status: FileStatus;
  /** R2 key on success; null while extracting or on failure. */
  readonly key: string | null;
  /** Uncompressed bytes written on success; null otherwise. */
  readonly bytes: number | null;
  /** Failure message on `failed`; null otherwise. */
  readonly error: string | null;
  /** This worker's CURRENT in-flight extraction count at report time. */
  readonly inFlight: number;
}

/** Input to {@link ExtractWorker.extractShard}. */
export interface ShardInput {
  /** The job id — used to address the coordinator stub for callbacks. */
  readonly jobId: string;
  /** This worker's shard index (0-based). */
  readonly workerIndex: number;
  /** The remote archive URL (same for every worker in the job). */
  readonly sourceUrl: string;
  /** The jobId-scoped output key prefix (every worker writes UNDER `<jobId>/`). */
  readonly prefix: string;
  /** The entries this worker is responsible for. */
  readonly entries: readonly ZipEntry[];
  /** TRANSIENT BYO credentials, when the destination is a user bucket. */
  readonly byo?: ByoConfig;
}

/** What a worker returns to the coordinator once its shard is fully settled. */
export interface ShardSummary {
  readonly workerIndex: number;
  readonly done: number;
  readonly failed: number;
  /** The worker's measured counters, for the coordinator to fold into the totals. */
  readonly metrics: WorkerMetricsContribution;
}

export class ExtractWorker extends DurableObject<ExtractWorkerEnv> {
  /**
   * Live metrics collector for THIS worker's shard (in-memory). `protected` (not
   * private) for the same reason `createRuntime` is: a test subclass / injected
   * instance wires its in-memory `Bucket` to this sink so the shard summary
   * captures real counters. Not part of the RPC surface.
   */
  protected metrics = new MetricsSink();
  /** TRANSIENT BYO credentials for the current run — never persisted/logged. */
  private byoConfig: ByoConfig | null = null;
  /** This worker's in-flight extraction count, reported to the coordinator. */
  private inFlight = 0;

  /**
   * Build the worker's Effect runtime. A `protected` seam (mirroring the
   * coordinator's `createRuntime`) so tests can subclass and inject an in-memory
   * `Source` without test-only branching on the hot path.
   */
  protected createRuntime(sourceUrl: string): AppRuntime {
    if (this.byoConfig) {
      const layer = Layer.mergeAll(
        makeHttpSource(sourceUrl, this.metrics),
        makeByoBucket(this.byoConfig, this.metrics),
      );
      return ManagedRuntime.make(layer);
    }
    return makeRuntime(sourceUrl, this.env.OUTPUT, this.metrics);
  }

  /**
   * The coordinator stub this worker reports back to. A `protected` seam so a
   * test subclass can capture the reports without a live coordinator DO.
   */
  protected coordinator(jobId: string): CoordinatorStub {
    // The job id IS the coordinator's DO name (the coordinator is `getByName(jobId)`),
    // so a worker can address its coordinator from the id alone.
    return this.env.EXTRACT_JOB.getByName(jobId);
  }

  /**
   * Extract this worker's shard. Runs the shard's entries through a bounded pool
   * of {@link WORKER_CONCURRENCY}, streaming each to R2 and reporting each file's
   * transitions back to the coordinator. Returns the shard summary once settled.
   *
   * Per-file failures are isolated — a bad entry is reported `failed` and the
   * worker continues; the shard summary still returns. The worker itself only
   * throws if it can't build the runtime at all (which the coordinator catches).
   */
  async extractShard(input: ShardInput): Promise<ShardSummary> {
    this.metrics = new MetricsSink();
    this.byoConfig = input.byo ?? null;
    this.inFlight = 0;

    const coordinator = this.coordinator(input.jobId);
    const rt = this.createRuntime(input.sourceUrl);
    let done = 0;
    let failed = 0;
    try {
      const queue = [...input.entries];
      const worker = async (): Promise<void> => {
        for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
          const ok = await this.extractOne(rt, entry, input, coordinator);
          if (ok) done += 1;
          else failed += 1;
        }
      };
      const pool = Array.from(
        { length: Math.min(WORKER_CONCURRENCY, input.entries.length) },
        worker,
      );
      await Promise.all(pool);
    } finally {
      this.byoConfig = null; // drop transient creds the moment the shard ends
      await rt.dispose();
    }

    const m = this.metrics.snapshot();
    return {
      workerIndex: input.workerIndex,
      done,
      failed,
      metrics: {
        rangeBytesFetched: m.rangeBytesFetched,
        rangeRequestCount: m.rangeRequestCount,
        computeMs: m.computeMs,
        r2Writes: m.r2Writes,
        filesExtracted: m.filesExtracted,
      },
    };
  }

  /**
   * Extract one entry, reporting `extracting` → (`done` | `failed`) back to the
   * coordinator. Returns true on success, false on an isolated per-file failure.
   * Every report carries the worker's current in-flight count so the coordinator
   * can track the live cross-worker peak concurrency.
   */
  private async extractOne(
    rt: AppRuntime,
    entry: ZipEntry,
    input: ShardInput,
    coordinator: CoordinatorStub,
  ): Promise<boolean> {
    this.inFlight += 1;
    await this.report(coordinator, input.workerIndex, {
      name: entry.name,
      status: 'extracting',
      key: null,
      bytes: null,
      error: null,
    });
    try {
      const result = await run(rt, extractEntry(entry, input.prefix, this.metrics));
      await this.report(coordinator, input.workerIndex, {
        name: entry.name,
        status: 'done',
        key: result.key,
        bytes: result.bytesWritten,
        error: null,
      });
      return true;
    } catch (err) {
      await this.report(coordinator, input.workerIndex, {
        name: entry.name,
        status: 'failed',
        key: null,
        bytes: null,
        error: errorMessage(err),
      });
      return false;
    } finally {
      this.inFlight -= 1;
    }
  }

  /**
   * Send one file report to the coordinator, stamping the worker's current
   * in-flight count. Best-effort: a transient RPC hiccup must not abort the
   * extraction (the R2 write already happened / will happen), so failures are
   * swallowed — the coordinator's authoritative `done`/`failed` totals come from
   * the returned {@link ShardSummary} regardless.
   */
  private async report(
    coordinator: CoordinatorStub,
    workerIndex: number,
    partial: Omit<FileReport, 'workerIndex' | 'inFlight'>,
  ): Promise<void> {
    try {
      await coordinator.reportFileResult({
        workerIndex,
        inFlight: this.inFlight,
        ...partial,
      });
    } catch {
      // Progress reporting is non-critical; never let it disrupt extraction.
    }
  }
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(err);
}

/**
 * The `ExtractJob` Durable Object — one instance per extraction job.
 *
 * Responsibilities:
 *   - Own the job's state in SQLite (status, per-file results, progress,
 *     metrics, expiry).
 *   - Fan out per-file extraction with BOUNDED concurrency so a job with
 *     thousands of entries doesn't open thousands of simultaneous range reads.
 *   - Isolate per-file failures: one bad entry is recorded as failed and the
 *     rest of the job continues.
 *   - Broadcast live progress to connected WebSocket clients via the
 *     Hibernation API (`ctx.acceptWebSocket` / `ctx.getWebSockets`), so the demo
 *     UI updates in real time without the DO being pinned to memory.
 *   - Collect REAL metrics (range bytes vs archive size, phase timings, peak
 *     concurrency, measured compute time, R2 writes) via a `MetricsSink`.
 *   - For demo-bucket jobs, schedule an alarm to delete the output after a TTL;
 *     the UI shows a live countdown to that cleanup. BYO jobs are NEVER cleaned.
 *
 * Why a DO: extraction is a coordinated, stateful, possibly long-running job.
 * A single instance gives us a serialization point for progress updates and a
 * durable place (SQLite) to read status from while work proceeds in the
 * background. `waitUntil` is a no-op in DOs — the instance simply stays alive
 * while the background extraction promise has pending I/O.
 *
 * BYO credentials are TRANSIENT: held only in `byoConfig` (in-memory) for the
 * run, never written to SQLite, never logged, never returned. They are dropped
 * when `runJob` finishes.
 */

import { DurableObject } from 'cloudflare:workers';
import { extractEntry, readIndex } from './extract';
import { makeRuntime, run, type AppRuntime } from './effect/runtime';
import { MetricsSink } from './effect/metrics-sink';
import { deriveMetrics, ZERO_METRICS, type MetricsView, type RawMetrics } from './metrics';
import { makeByoBucket, type ByoConfig } from './destination';
import { Layer, ManagedRuntime } from 'effect';
import { makeHttpSource } from './effect/services';
import { overallPercent, type ProgressMessage } from './progress';
import { EVENT_TYPES } from './registry/codes';
import { REGISTRY_NAME, type Registry } from './registry/registry';
import type { ZipEntry } from './zip';

/** Bindings the DO needs. Mirrors the Worker `Env`. */
export interface JobEnv {
  OUTPUT: R2Bucket;
  /** Singleton registry — for recording per-code usage events. */
  REGISTRY: DurableObjectNamespace<Registry>;
  EXTRACT_TTL_HOURS?: string;
}

/** How many files to extract simultaneously. Bounds open range reads + memory. */
const CONCURRENCY = 6;

/** Default cleanup TTL for demo-bucket output, in hours. */
const DEFAULT_TTL_HOURS = 2;

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';
export type FileStatus = 'pending' | 'extracting' | 'done' | 'failed';
export type Destination = 'demo' | 'byo';

export interface FileResult {
  readonly name: string;
  readonly key: string | null;
  readonly status: FileStatus;
  readonly bytes: number | null;
  readonly error: string | null;
}

export interface JobReport {
  readonly id: string;
  readonly status: JobStatus;
  readonly sourceUrl: string;
  readonly prefix: string;
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  readonly error: string | null;
  readonly files: readonly FileResult[];
  readonly metrics: MetricsView;
  readonly destination: Destination;
  /** Unix-ms when demo output is cleaned up; null for BYO or before completion. */
  readonly expiresAt: number | null;
  readonly percent: number;
}

/** Input to start a job. `byo` carries TRANSIENT credentials (never persisted). */
export interface StartInput {
  readonly id: string;
  readonly sourceUrl: string;
  readonly prefix: string;
  readonly files?: string[];
  readonly destination: Destination;
  readonly byo?: ByoConfig;
  /** Access code that started the session — for usage attribution. */
  readonly code?: string;
  /** Source label ("url" or a sample id) for the job_started event detail. */
  readonly sourceLabel?: string;
}

interface JobRow extends Record<string, SqlStorageValue> {
  id: string;
  status: JobStatus;
  source_url: string;
  prefix: string;
  total: number;
  error: string | null;
  destination: string;
  expires_at: number | null;
  metrics_json: string | null;
}

interface FileRow extends Record<string, SqlStorageValue> {
  name: string;
  key: string | null;
  status: FileStatus;
  bytes: number | null;
  error: string | null;
}

export class ExtractJob extends DurableObject<JobEnv> {
  /** Live metrics collector for the current run (in-memory). */
  private metrics = new MetricsSink();
  /**
   * TRANSIENT BYO credentials for the current run. In-memory only — NEVER
   * written to SQLite, logged, or returned. Cleared when the run completes.
   */
  private byoConfig: ByoConfig | null = null;
  /** In-flight extraction count, for the peak-concurrency metric. */
  private inFlight = 0;

  constructor(ctx: DurableObjectState, env: JobEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS job (
        id           TEXT PRIMARY KEY,
        status       TEXT NOT NULL,
        source_url   TEXT NOT NULL,
        prefix       TEXT NOT NULL,
        total        INTEGER NOT NULL DEFAULT 0,
        error        TEXT,
        destination  TEXT NOT NULL DEFAULT 'demo',
        expires_at   INTEGER,
        metrics_json TEXT
      );
      CREATE TABLE IF NOT EXISTS file (
        name   TEXT PRIMARY KEY,
        key    TEXT,
        status TEXT NOT NULL,
        bytes  INTEGER,
        error  TEXT
      );
    `);
  }

  // -----------------------------------------------------------------------------------------------
  // RPC: start / report / WebSocket upgrade
  // -----------------------------------------------------------------------------------------------

  /**
   * Accept a job and start extraction in the background. Returns immediately
   * with the jobId — the DO stays alive while the background promise runs.
   *
   * `files === undefined` means "extract everything".
   */
  async start(input: StartInput): Promise<{ id: string; status: JobStatus }> {
    this.metrics = new MetricsSink();
    this.byoConfig = input.byo ?? null; // transient, in-memory only

    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO job
         (id, status, source_url, prefix, total, error, destination, expires_at, metrics_json)
       VALUES (?, ?, ?, ?, 0, NULL, ?, NULL, NULL)`,
      input.id,
      'pending' satisfies JobStatus,
      input.sourceUrl,
      input.prefix,
      input.destination,
    );

    // Fire-and-forget: do NOT await. The DO remains active due to pending I/O.
    void this.runJob(input);

    return { id: input.id, status: 'pending' };
  }

  /** Read the current job report (status + per-file results + metrics). */
  async report(): Promise<JobReport | null> {
    const jobRows = this.ctx.storage.sql.exec<JobRow>('SELECT * FROM job LIMIT 1').toArray();
    const job = jobRows[0];
    if (!job) return null;

    const fileRows = this.ctx.storage.sql
      .exec<FileRow>('SELECT name, key, status, bytes, error FROM file ORDER BY name')
      .toArray();

    const done = fileRows.filter((f) => f.status === 'done').length;
    const failed = fileRows.filter((f) => f.status === 'failed').length;

    return {
      id: job.id,
      status: job.status,
      sourceUrl: job.source_url,
      prefix: job.prefix,
      total: job.total,
      done,
      failed,
      error: job.error,
      destination: (job.destination as Destination) ?? 'demo',
      expiresAt: job.expires_at,
      percent: overallPercent(done, failed, job.total),
      metrics: this.currentMetrics(job.metrics_json),
      files: fileRows.map((f) => ({
        name: f.name,
        key: f.key,
        status: f.status,
        bytes: f.bytes,
        error: f.error,
      })),
    };
  }

  /**
   * WebSocket upgrade handler. The Worker forwards the `GET /jobs/:id/ws`
   * upgrade request here. We accept the server side via the Hibernation API so
   * the DO can be evicted between progress bursts without dropping the socket,
   * then immediately send a full snapshot so a late-joining client catches up.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Hibernatable accept — the runtime keeps the socket open while the DO can
    // be evicted; a future message re-runs the constructor and routes it here.
    this.ctx.acceptWebSocket(server);

    // Send the current snapshot to the just-connected client.
    const snapshot = await this.snapshotMessage();
    if (snapshot) {
      try {
        server.send(JSON.stringify(snapshot));
      } catch {
        // Socket may have closed immediately; ignore.
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Hibernation handler: a client sent us a message. We only support ping. */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message === 'string' && message === 'ping') {
      try {
        ws.send('pong');
      } catch {
        // ignore
      }
    }
  }

  /** Hibernation handler: client disconnected. The runtime tracks the socket set. */
  webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): void {
    try {
      ws.close(code === 1006 ? 1000 : code);
    } catch {
      // already closed
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Alarm: cleanup of demo-bucket output
  // -----------------------------------------------------------------------------------------------

  /**
   * Alarm handler — fires `EXTRACT_TTL_HOURS` after a demo-bucket job completes.
   * Deletes EVERY R2 object under the job's prefix. BYO jobs never schedule an
   * alarm (their data is the user's; we never touch it).
   */
  async alarm(): Promise<void> {
    const job = this.ctx.storage.sql.exec<JobRow>('SELECT * FROM job LIMIT 1').toArray()[0];
    if (!job || job.destination !== 'demo') return;
    await this.deletePrefix(job.prefix);
    // Mark cleanup done so the UI/report reflects expiry has passed.
    this.ctx.storage.sql.exec('UPDATE job SET expires_at = ? WHERE 1', Date.now());
  }

  /** Delete all R2 objects under a prefix, paging through the listing. */
  private async deletePrefix(prefix: string): Promise<void> {
    const cleanPrefix = prefix.replace(/\/+$/, '');
    let cursor: string | undefined;
    do {
      const listing = await this.env.OUTPUT.list({
        prefix: cleanPrefix ? `${cleanPrefix}/` : undefined,
        cursor,
      });
      const keys = listing.objects.map((o) => o.key);
      if (keys.length > 0) await this.env.OUTPUT.delete(keys);
      cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor);
  }

  // -----------------------------------------------------------------------------------------------
  // Background work
  // -----------------------------------------------------------------------------------------------

  /**
   * Build the Effect runtime for a job. A `protected` seam (rather than a
   * direct `makeRuntime` call) so tests can subclass the DO and swap in an
   * in-memory `Source`, without any test-only branching in the hot path.
   *
   * The runtime's `Bucket` is the demo R2 binding OR a SigV4 BYO bucket; both
   * are wired to the same `MetricsSink` so writes are counted identically.
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

  private async runJob(input: StartInput): Promise<void> {
    const rt = this.createRuntime(input.sourceUrl);
    const startedAt = Date.now();
    try {
      this.setJobStatus('running');
      await this.broadcastSnapshot();

      // Phase 1: index read (measured wallclock).
      const indexStart = performance.now();
      const entries = await run(rt, readIndex(this.metrics));
      this.metrics.setIndexReadMs(performance.now() - indexStart);

      const selected = selectEntries(entries, input.files);

      // Attribute job start to the session's code (real requested-file count).
      await this.recordUsage(input.code, EVENT_TYPES.jobStarted, {
        source: input.sourceLabel ?? 'url',
        requestedFiles: input.files === undefined ? selected.length : input.files.length,
      });

      // Seed the file table with everything we intend to extract.
      for (const entry of selected) {
        this.ctx.storage.sql.exec(
          'INSERT OR REPLACE INTO file (name, key, status, bytes, error) VALUES (?, NULL, ?, NULL, NULL)',
          entry.name,
          'pending' satisfies FileStatus,
        );
      }
      this.ctx.storage.sql.exec('UPDATE job SET total = ? WHERE 1', selected.length);
      this.persistMetrics();
      await this.broadcastSnapshot();

      // Phase 2: extraction (measured wallclock).
      const extractStart = performance.now();
      await this.extractAll(rt, selected, input.prefix);
      this.metrics.setExtractionMs(performance.now() - extractStart);
      this.persistMetrics();

      // A job is "completed" even if some files failed — per-file failures are
      // recorded individually and do not fail the whole job.
      this.setJobStatus('completed');
      await this.scheduleCleanupIfDemo(input.destination, input.prefix);

      // Attribute completion with REAL metrics the run already measured.
      const m = deriveMetrics(this.metrics.snapshot());
      await this.recordUsage(input.code, EVENT_TYPES.jobCompleted, {
        filesExtracted: m.filesExtracted,
        bytes: m.rangeBytesFetched,
        percentOfArchive: m.rangeBytesPercent,
        durationMs: Date.now() - startedAt,
      });

      await this.broadcastDone('completed');
    } catch (err) {
      this.recordJobError(err);
      this.persistMetrics();
      await this.broadcastDone('failed');
    } finally {
      // Drop transient BYO credentials the moment the run ends.
      this.byoConfig = null;
      await rt.dispose();
    }
  }

  /**
   * Record a usage event against the session's code via the singleton Registry.
   * Best-effort and isolated: a Registry hiccup must never fail or stall the
   * extraction, so failures are swallowed (the event is just lost). No-op when
   * the job carries no code (e.g. direct API use without a code-bound session).
   */
  private async recordUsage(
    code: string | undefined,
    type: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (!code) return;
    try {
      await this.env.REGISTRY.getByName(REGISTRY_NAME).recordEvent(code, type, detail);
    } catch {
      // Usage tracking is non-critical; never let it disrupt the job.
    }
  }

  /**
   * Schedule the cleanup alarm for demo-bucket jobs and record `expiresAt`.
   * BYO jobs return without scheduling anything — their data is never deleted.
   */
  private async scheduleCleanupIfDemo(destination: Destination, _prefix: string): Promise<void> {
    if (destination !== 'demo') return;
    const ttlHours = this.ttlHours();
    const expiresAt = Date.now() + ttlHours * 60 * 60 * 1000;
    this.ctx.storage.sql.exec('UPDATE job SET expires_at = ? WHERE 1', expiresAt);
    await this.ctx.storage.setAlarm(expiresAt);
  }

  private ttlHours(): number {
    const raw = this.env.EXTRACT_TTL_HOURS;
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_HOURS;
  }

  /** Extract entries with a bounded worker pool of size {@link CONCURRENCY}. */
  private async extractAll(
    rt: AppRuntime,
    entries: readonly ZipEntry[],
    prefix: string,
  ): Promise<void> {
    const queue = [...entries];
    const worker = async (): Promise<void> => {
      for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
        await this.extractOne(rt, entry, prefix);
      }
    };
    const pool = Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker);
    await Promise.all(pool);
  }

  /** Extract one entry, recording success or an isolated per-file failure. */
  private async extractOne(rt: AppRuntime, entry: ZipEntry, prefix: string): Promise<void> {
    this.inFlight += 1;
    this.metrics.observeConcurrency(this.inFlight);
    this.markFile(entry.name, 'extracting');
    await this.broadcastFile(entry.name);
    try {
      const result = await run(rt, extractEntry(entry, prefix, this.metrics));
      this.ctx.storage.sql.exec(
        'UPDATE file SET key = ?, status = ?, bytes = ?, error = NULL WHERE name = ?',
        result.key,
        'done' satisfies FileStatus,
        result.bytesWritten,
        entry.name,
      );
      await this.broadcastFile(entry.name);
    } catch (err) {
      this.ctx.storage.sql.exec(
        'UPDATE file SET status = ?, error = ? WHERE name = ?',
        'failed' satisfies FileStatus,
        errorMessage(err),
        entry.name,
      );
      await this.broadcastFile(entry.name);
    } finally {
      this.inFlight -= 1;
      this.persistMetrics();
    }
  }

  private markFile(name: string, status: FileStatus): void {
    this.ctx.storage.sql.exec('UPDATE file SET status = ? WHERE name = ?', status, name);
  }

  private setJobStatus(status: JobStatus): void {
    this.ctx.storage.sql.exec('UPDATE job SET status = ? WHERE 1', status);
  }

  private recordJobError(err: unknown): void {
    this.ctx.storage.sql.exec(
      'UPDATE job SET status = ?, error = ? WHERE 1',
      'failed' satisfies JobStatus,
      errorMessage(err),
    );
  }

  // -----------------------------------------------------------------------------------------------
  // Metrics + broadcasting
  // -----------------------------------------------------------------------------------------------

  /** Persist the live metrics snapshot into SQLite so `report()` survives eviction. */
  private persistMetrics(): void {
    this.ctx.storage.sql.exec(
      'UPDATE job SET metrics_json = ? WHERE 1',
      JSON.stringify(this.metrics.snapshot()),
    );
  }

  /**
   * Current derived metrics. Prefers the live in-memory sink (which has the
   * latest counters), falling back to the persisted JSON when the DO was
   * reconstructed after eviction and the sink is fresh.
   */
  private currentMetrics(persistedJson: string | null): MetricsView {
    const live = this.metrics.snapshot();
    const hasLive = live.rangeRequestCount > 0 || live.filesExtracted > 0 || live.archiveSize > 0;
    if (hasLive) return deriveMetrics(live);
    if (persistedJson) {
      try {
        return deriveMetrics(JSON.parse(persistedJson) as RawMetrics);
      } catch {
        // fall through
      }
    }
    return deriveMetrics(ZERO_METRICS);
  }

  /** Broadcast a JSON message to every connected WebSocket. */
  private broadcast(message: ProgressMessage): void {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Socket may be mid-close; the runtime will clean it up.
      }
    }
  }

  /** Build a full snapshot message from current state (or null if no job). */
  private async snapshotMessage(): Promise<ProgressMessage | null> {
    const report = await this.report();
    if (!report) return null;
    return {
      type: 'snapshot',
      status: report.status,
      total: report.total,
      done: report.done,
      failed: report.failed,
      percent: report.percent,
      error: report.error,
      files: report.files,
      metrics: report.metrics,
      expiresAt: report.expiresAt,
      destination: report.destination,
    };
  }

  private async broadcastSnapshot(): Promise<void> {
    const msg = await this.snapshotMessage();
    if (msg) this.broadcast(msg);
  }

  /** Broadcast a single file's current state as a `file` delta. */
  private async broadcastFile(name: string): Promise<void> {
    const report = await this.report();
    if (!report) return;
    const file = report.files.find((f) => f.name === name);
    if (!file) return;
    this.broadcast({
      type: 'file',
      file,
      done: report.done,
      failed: report.failed,
      total: report.total,
      percent: report.percent,
      metrics: report.metrics,
    });
  }

  private async broadcastDone(status: JobStatus): Promise<void> {
    const report = await this.report();
    this.broadcast({
      type: 'done',
      status,
      metrics: report?.metrics ?? deriveMetrics(ZERO_METRICS),
      expiresAt: report?.expiresAt ?? null,
    });
  }
}

// -------------------------------------------------------------------------------------------------
// Pure helpers
// -------------------------------------------------------------------------------------------------

/**
 * Choose which entries to extract. `undefined` selects all; otherwise the named
 * subset, preserving the request order and silently skipping directory entries
 * (names ending in "/").
 */
export function selectEntries(entries: readonly ZipEntry[], files?: string[]): readonly ZipEntry[] {
  const realFiles = entries.filter((e) => !e.name.endsWith('/'));
  if (files === undefined) return realFiles;

  const byName = new Map(realFiles.map((e) => [e.name, e]));
  const out: ZipEntry[] = [];
  for (const name of files) {
    const entry = byName.get(name);
    if (entry) out.push(entry);
  }
  return out;
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(err);
}

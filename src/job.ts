/**
 * The `ExtractJob` Durable Object — one instance per extraction job.
 *
 * Responsibilities:
 *   - Own the job's state in SQLite (status, per-file results, progress).
 *   - Fan out per-file extraction with BOUNDED concurrency so a job with
 *     thousands of entries doesn't open thousands of simultaneous range reads.
 *   - Isolate per-file failures: one bad entry is recorded as failed and the
 *     rest of the job continues.
 *
 * Why a DO: extraction is a coordinated, stateful, possibly long-running job.
 * A single instance gives us a serialization point for progress updates and a
 * durable place (SQLite) to read status from while work proceeds in the
 * background. `waitUntil` is a no-op in DOs — the instance simply stays alive
 * while the background extraction promise has pending I/O.
 */

import { DurableObject } from 'cloudflare:workers';
import { extractEntry, readIndex } from './extract';
import { makeRuntime, run, type AppRuntime } from './effect/runtime';
import type { ZipEntry } from './zip';

/** Bindings the DO needs. Mirrors the Worker `Env`. */
export interface JobEnv {
  OUTPUT: R2Bucket;
}

/** How many files to extract simultaneously. Bounds open range reads + memory. */
const CONCURRENCY = 6;

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';
export type FileStatus = 'pending' | 'done' | 'failed';

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
}

interface JobRow extends Record<string, SqlStorageValue> {
  id: string;
  status: JobStatus;
  source_url: string;
  prefix: string;
  total: number;
  error: string | null;
}

interface FileRow extends Record<string, SqlStorageValue> {
  name: string;
  key: string | null;
  status: FileStatus;
  bytes: number | null;
  error: string | null;
}

export class ExtractJob extends DurableObject<JobEnv> {
  constructor(ctx: DurableObjectState, env: JobEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS job (
        id         TEXT PRIMARY KEY,
        status     TEXT NOT NULL,
        source_url TEXT NOT NULL,
        prefix     TEXT NOT NULL,
        total      INTEGER NOT NULL DEFAULT 0,
        error      TEXT
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

  /**
   * Accept a job and start extraction in the background. Returns immediately
   * with the jobId — the DO stays alive while the background promise runs.
   *
   * `files === undefined` means "extract everything".
   */
  async start(input: {
    id: string;
    sourceUrl: string;
    prefix: string;
    files?: string[];
  }): Promise<{ id: string; status: JobStatus }> {
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO job (id, status, source_url, prefix, total, error) VALUES (?, ?, ?, ?, 0, NULL)',
      input.id,
      'pending' satisfies JobStatus,
      input.sourceUrl,
      input.prefix,
    );

    // Fire-and-forget: do NOT await. The DO remains active due to pending I/O.
    void this.runJob(input.sourceUrl, input.prefix, input.files);

    return { id: input.id, status: 'pending' };
  }

  /** Read the current job report (status + per-file results). */
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
      files: fileRows.map((f) => ({
        name: f.name,
        key: f.key,
        status: f.status,
        bytes: f.bytes,
        error: f.error,
      })),
    };
  }

  // -----------------------------------------------------------------------------------------------
  // Background work
  // -----------------------------------------------------------------------------------------------

  /**
   * Build the Effect runtime for a job. A `protected` seam (rather than a
   * direct `makeRuntime` call) so tests can subclass the DO and swap in an
   * in-memory `Source`, without any test-only branching in the hot path.
   */
  protected createRuntime(sourceUrl: string): AppRuntime {
    return makeRuntime(sourceUrl, this.env.OUTPUT);
  }

  private async runJob(sourceUrl: string, prefix: string, files?: string[]): Promise<void> {
    const rt = this.createRuntime(sourceUrl);
    try {
      this.setJobStatus('running');

      const entries = await run(rt, readIndex());
      const selected = selectEntries(entries, files);

      // Seed the file table with everything we intend to extract.
      for (const entry of selected) {
        this.ctx.storage.sql.exec(
          'INSERT OR REPLACE INTO file (name, key, status, bytes, error) VALUES (?, NULL, ?, NULL, NULL)',
          entry.name,
          'pending' satisfies FileStatus,
        );
      }
      this.ctx.storage.sql.exec('UPDATE job SET total = ? WHERE 1', selected.length);

      await this.extractAll(rt, selected, prefix);

      // A job is "completed" even if some files failed — per-file failures are
      // recorded individually and do not fail the whole job.
      this.setJobStatus('completed');
    } catch (err) {
      this.recordJobError(err);
    } finally {
      await rt.dispose();
    }
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
    try {
      const result = await run(rt, extractEntry(entry, prefix));
      this.ctx.storage.sql.exec(
        'UPDATE file SET key = ?, status = ?, bytes = ?, error = NULL WHERE name = ?',
        result.key,
        'done' satisfies FileStatus,
        result.bytesWritten,
        entry.name,
      );
    } catch (err) {
      this.ctx.storage.sql.exec(
        'UPDATE file SET status = ?, error = ? WHERE name = ?',
        'failed' satisfies FileStatus,
        errorMessage(err),
        entry.name,
      );
    }
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

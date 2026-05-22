/**
 * The WebSocket progress-message protocol — the shape the DO broadcasts and the
 * demo UI consumes. Pure type/serialisation definitions, no IO.
 *
 * Messages are JSON. Every broadcast is a `ProgressMessage`; the UI switches on
 * `type`. `snapshot` is sent on connect (full current state) and whenever the
 * job materially changes; `file` is a per-file status delta; `done` marks the
 * job finished. All numbers carried here are the REAL metrics from `metrics.ts`.
 */

import type { MetricsView } from './metrics';
import type { FileResult, JobStatus } from './job';

/** A full snapshot of job state — sent on connect and on status changes. */
export interface SnapshotMessage {
  readonly type: 'snapshot';
  readonly status: JobStatus;
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  /** Overall completion percentage, 0–100 (done+failed over total). */
  readonly percent: number;
  readonly error: string | null;
  readonly files: readonly FileResult[];
  readonly metrics: MetricsView;
  /** Unix-ms when demo-bucket output will be cleaned up; null for BYO/none. */
  readonly expiresAt: number | null;
  /** 'demo' (ephemeral, auto-cleaned) or 'byo' (user's bucket, kept). */
  readonly destination: 'demo' | 'byo';
}

/** A single file's status transition. */
export interface FileMessage {
  readonly type: 'file';
  readonly file: FileResult;
  readonly done: number;
  readonly failed: number;
  readonly total: number;
  readonly percent: number;
  readonly metrics: MetricsView;
}

/** Terminal message — the job has finished (completed or failed). */
export interface DoneMessage {
  readonly type: 'done';
  readonly status: JobStatus;
  readonly metrics: MetricsView;
  readonly expiresAt: number | null;
}

export type ProgressMessage = SnapshotMessage | FileMessage | DoneMessage;

/** Overall percentage from settled (done+failed) over total. 0 when total 0. */
export function overallPercent(done: number, failed: number, total: number): number {
  if (total <= 0) return 0;
  const settled = Math.min(done + failed, total);
  return Math.round((settled / total) * 1000) / 10;
}

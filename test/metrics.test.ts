/**
 * Pure metrics-math tests: range folding, peak concurrency, and the derived
 * view (totals, the headline percentage, bytes-saved). The numbers the demo
 * surfaces are computed here, so a critical reviewer can trust the labels.
 */

import { describe, expect, it } from 'vitest';
import {
  deriveMetrics,
  mergeWorkerMetrics,
  recordConcurrency,
  recordRange,
  ZERO_METRICS,
  type RawMetrics,
  type WorkerMetricsContribution,
} from '../src/metrics';

describe('recordRange', () => {
  it('adds the byte span and increments the request count', () => {
    let m = ZERO_METRICS;
    m = recordRange(m, 0, 100); // 100 bytes
    m = recordRange(m, 100, 250); // 150 bytes
    expect(m.rangeBytesFetched).toBe(250);
    expect(m.rangeRequestCount).toBe(2);
  });
  it('clamps a non-positive span to zero bytes but still counts the request', () => {
    const m = recordRange(ZERO_METRICS, 50, 50);
    expect(m.rangeBytesFetched).toBe(0);
    expect(m.rangeRequestCount).toBe(1);
  });
});

describe('recordConcurrency', () => {
  it('raises the peak but never lowers it', () => {
    let m = ZERO_METRICS;
    m = recordConcurrency(m, 3);
    expect(m.peakConcurrency).toBe(3);
    m = recordConcurrency(m, 2); // lower — no change
    expect(m.peakConcurrency).toBe(3);
    m = recordConcurrency(m, 6); // higher — raises
    expect(m.peakConcurrency).toBe(6);
  });
});

describe('mergeWorkerMetrics', () => {
  const contribution: WorkerMetricsContribution = {
    rangeBytesFetched: 1000,
    rangeRequestCount: 5,
    computeMs: 12.5,
    r2Writes: 3,
    filesExtracted: 3,
  };

  it('adds the worker counters into the running totals', () => {
    const base: RawMetrics = {
      ...ZERO_METRICS,
      rangeBytesFetched: 200,
      rangeRequestCount: 2,
      computeMs: 1,
      r2Writes: 1,
      filesExtracted: 1,
    };
    const merged = mergeWorkerMetrics(base, contribution);
    expect(merged.rangeBytesFetched).toBe(1200);
    expect(merged.rangeRequestCount).toBe(7);
    expect(merged.computeMs).toBe(13.5);
    expect(merged.r2Writes).toBe(4);
    expect(merged.filesExtracted).toBe(4);
  });

  it('leaves coordinator-owned fields untouched (no double-counting)', () => {
    const base: RawMetrics = {
      ...ZERO_METRICS,
      archiveSize: 5000,
      centralDirectoryReads: 1,
      peakConcurrency: 12,
      indexReadMs: 9,
      extractionMs: 0,
      workerCount: 3,
      phase: 'extracting',
    };
    const merged = mergeWorkerMetrics(base, contribution);
    // These belong to the coordinator and must NOT be folded in from a worker.
    expect(merged.archiveSize).toBe(5000);
    expect(merged.centralDirectoryReads).toBe(1);
    expect(merged.peakConcurrency).toBe(12);
    expect(merged.indexReadMs).toBe(9);
    expect(merged.extractionMs).toBe(0);
    expect(merged.workerCount).toBe(3);
    expect(merged.phase).toBe('extracting');
  });

  it('is additive across multiple workers', () => {
    let m: RawMetrics = ZERO_METRICS;
    m = mergeWorkerMetrics(m, contribution);
    m = mergeWorkerMetrics(m, contribution);
    m = mergeWorkerMetrics(m, contribution);
    expect(m.filesExtracted).toBe(9);
    expect(m.r2Writes).toBe(9);
    expect(m.rangeBytesFetched).toBe(3000);
  });
});

describe('deriveMetrics', () => {
  const base: RawMetrics = {
    ...ZERO_METRICS,
    archiveSize: 1000,
    rangeBytesFetched: 250,
    indexReadMs: 12.34,
    extractionMs: 87.66,
  };

  it('computes the headline percentage (bytes fetched / archive)', () => {
    expect(deriveMetrics(base).rangeBytesPercent).toBe(25);
  });

  it('computes bytes saved as archive minus fetched', () => {
    expect(deriveMetrics(base).bytesSaved).toBe(750);
  });

  it('sums total time from the two phases', () => {
    expect(deriveMetrics(base).totalMs).toBe(100);
  });

  it('never divides by zero — 0% when archive size is unknown', () => {
    const view = deriveMetrics({ ...ZERO_METRICS, rangeBytesFetched: 500 });
    expect(view.rangeBytesPercent).toBe(0);
    expect(Number.isFinite(view.rangeBytesPercent)).toBe(true);
  });

  it('never reports negative savings if fetched exceeds archive (defensive)', () => {
    const view = deriveMetrics({ ...ZERO_METRICS, archiveSize: 100, rangeBytesFetched: 300 });
    expect(view.bytesSaved).toBe(0);
  });

  it('rounds the percentage to a sane precision', () => {
    const view = deriveMetrics({ ...ZERO_METRICS, archiveSize: 3, rangeBytesFetched: 1 });
    // 1/3 = 33.3333...% → rounded to 4 decimals
    expect(view.rangeBytesPercent).toBe(33.3333);
  });
});

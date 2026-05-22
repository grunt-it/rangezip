/**
 * Integration tests for the `ExtractWorker` Durable Object — the per-shard
 * fan-out unit that gives rangezip true `N×6` parallelism.
 *
 * Run inside the Workers runtime (`workerd`) so the REAL `DecompressionStream`,
 * `FixedLengthStream`, and R2 binding are exercised. The remote archive is
 * simulated by an in-memory `Source` layer injected through the worker's
 * `protected createRuntime` seam (overridden on the instance inside
 * `runInDurableObject`), and the coordinator callback is a capturing fake
 * injected through the `protected coordinator` seam — so we can assert exactly
 * what the worker reports back and what lands in R2, without standing up a live
 * coordinator DO or a real HTTP source.
 *
 * What this proves about the re-architecture:
 *   - A shard's entries all land in R2 under the jobId-scoped prefix, bytes
 *     intact (STORED + DEFLATE), streamed (never buffered).
 *   - The worker reports each file's `extracting → done`/`failed` transition,
 *     stamped with its live in-flight count (the input to the coordinator's
 *     aggregated peak-concurrency metric).
 *   - The returned shard summary carries measured counters (bytes, R2 writes,
 *     files) for the coordinator to fold into the job-wide headline.
 *   - Per-file failures inside a shard are isolated — a bad entry is reported
 *     failed and the rest of the shard still extracts.
 */

import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { describe, expect, it } from 'vitest';
import { RangeFetchError } from '../src/effect/errors';
import { makeR2Bucket, Source, type ByteRange } from '../src/effect/services';
import type { AppRuntime } from '../src/effect/runtime';
import type { MetricsSink } from '../src/effect/metrics-sink';
import type { CoordinatorStub, ExtractWorker, FileReport } from '../src/extract-worker';
import { readIndex } from '../src/extract';
import { fixtureEntry, makeZipFixture } from './fixtures';
import type { ZipEntry } from '../src/zip';

/**
 * Test-only view of the worker's protected seams, so we can inject an in-memory
 * source + a capturing coordinator on the instance. A purely structural shape
 * (NOT `extends ExtractWorker` — that would clash on the protected members);
 * the live instance is cast to it via `unknown`. The seams are protected on the
 * class precisely so a test can override them on the instance — the same pattern
 * the protected `createRuntime`/`coordinator`/`metrics` modifiers were built for.
 */
interface TestableWorker {
  metrics: MetricsSink;
  createRuntime(sourceUrl: string): AppRuntime;
  coordinator(jobId: string): CoordinatorStub;
  extractShard: ExtractWorker['extractShard'];
}

/** Reveal the protected seams of a live worker instance for injection. */
function testable(instance: unknown): TestableWorker {
  return instance as TestableWorker;
}

/**
 * In-memory `Source` that slices a fixture buffer like an HTTP range-GET. When a
 * `MetricsSink` is supplied it records each range's byte span exactly as the
 * production HTTP source does (`metrics.range(start, end)`), so the worker's
 * shard summary reflects real fetched-byte counters.
 */
function inMemorySource(bytes: Uint8Array, metrics?: MetricsSink): Layer.Layer<Source> {
  const slice = (range: ByteRange) => {
    metrics?.range(range.start, range.end);
    return bytes.subarray(range.start, range.end);
  };
  return Layer.succeed(Source, {
    size: Effect.succeed(bytes.byteLength),
    readRange: (range) =>
      range.start < 0 || range.end > bytes.byteLength
        ? Effect.fail(new RangeFetchError(`range ${range.start}-${range.end} out of bounds`))
        : Effect.succeed(slice(range)),
    streamRange: (range) =>
      Effect.succeed(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(slice(range));
            controller.close();
          },
        }),
      ),
  });
}

/** Parse a fixture's index with a throwaway in-memory runtime (no worker needed). */
async function indexOf(bytes: Uint8Array): Promise<readonly ZipEntry[]> {
  const layer = Layer.mergeAll(inMemorySource(bytes), makeR2Bucket(env.OUTPUT));
  return Effect.runPromise(Effect.provide(readIndex(), layer));
}

/**
 * Override the worker instance's protected seams: an in-memory source over
 * `bytes`, wired to the worker's own metrics sink so the shard summary captures
 * real counters; and a capturing coordinator that records every report.
 */
function inject(worker: TestableWorker, bytes: Uint8Array): { reports: FileReport[] } {
  const reports: FileReport[] = [];
  worker.createRuntime = () => {
    const layer = Layer.mergeAll(
      inMemorySource(bytes, worker.metrics),
      makeR2Bucket(env.OUTPUT, worker.metrics),
    );
    return ManagedRuntime.make(layer) as AppRuntime;
  };
  worker.coordinator = () => ({
    reportFileResult: async (report: FileReport) => {
      reports.push(report);
    },
  });
  return { reports };
}

describe('ExtractWorker.extractShard', () => {
  it('extracts a shard of entries to R2 under the jobId prefix, bytes intact', async () => {
    const fixture = makeZipFixture();
    const entries = await indexOf(fixture.bytes);

    const stub = env.EXTRACT_WORKER.getByName('job-fanout-1:w0');
    const summary = await runInDurableObject(stub, async (instance) => {
      const worker = testable(instance);
      inject(worker, fixture.bytes);
      return worker.extractShard({
        jobId: 'job-fanout-1',
        workerIndex: 0,
        sourceUrl: 'https://simulated/archive.zip',
        prefix: 'job-fanout-1',
        entries,
      });
    });

    // Every file in the shard succeeded.
    expect(summary.done).toBe(entries.length);
    expect(summary.failed).toBe(0);
    expect(summary.workerIndex).toBe(0);

    // All landed under the jobId-scoped prefix with the original bytes.
    for (const name of ['hello.txt', 'raw.bin', 'dir/data.json']) {
      const obj = await env.OUTPUT.get(`job-fanout-1/${name}`);
      expect(obj).not.toBeNull();
      const got = new Uint8Array(await obj!.arrayBuffer());
      expect(got).toEqual(fixtureEntry(fixture, name).contents);
    }
  });

  it('reports each file extracting→done with the live in-flight count', async () => {
    const fixture = makeZipFixture();
    const entries = await indexOf(fixture.bytes);

    const stub = env.EXTRACT_WORKER.getByName('job-fanout-2:w0');
    const reports = await runInDurableObject(stub, async (instance) => {
      const worker = testable(instance);
      const captured = inject(worker, fixture.bytes);
      await worker.extractShard({
        jobId: 'job-fanout-2',
        workerIndex: 3,
        sourceUrl: 'https://simulated/archive.zip',
        prefix: 'job-fanout-2',
        entries,
      });
      return captured.reports;
    });

    // Each file produced an `extracting` then a terminal report.
    const byName = new Map<string, FileReport[]>();
    for (const r of reports) {
      byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
      // Every report carries this worker's shard index and a non-negative in-flight.
      expect(r.workerIndex).toBe(3);
      expect(r.inFlight).toBeGreaterThanOrEqual(0);
    }
    for (const e of entries) {
      const seq = byName.get(e.name)!;
      expect(seq.some((r) => r.status === 'extracting')).toBe(true);
      expect(seq.some((r) => r.status === 'done')).toBe(true);
    }
    // In-flight peaked at >= 1 while files were extracting.
    expect(Math.max(...reports.map((r) => r.inFlight))).toBeGreaterThanOrEqual(1);
  });

  it('returns measured counters in the shard summary', async () => {
    const fixture = makeZipFixture();
    const entries = await indexOf(fixture.bytes);

    const stub = env.EXTRACT_WORKER.getByName('job-fanout-3:w0');
    const summary = await runInDurableObject(stub, async (instance) => {
      const worker = testable(instance);
      inject(worker, fixture.bytes);
      return worker.extractShard({
        jobId: 'job-fanout-3',
        workerIndex: 0,
        sourceUrl: 'https://simulated/archive.zip',
        prefix: 'job-fanout-3',
        entries,
      });
    });

    // One R2 write + one file extracted per entry; bytes were really fetched.
    expect(summary.metrics.filesExtracted).toBe(entries.length);
    expect(summary.metrics.r2Writes).toBe(entries.length);
    expect(summary.metrics.rangeBytesFetched).toBeGreaterThan(0);
    expect(summary.metrics.rangeRequestCount).toBeGreaterThanOrEqual(entries.length);
  });

  it('isolates a per-file failure — the rest of the shard still extracts', async () => {
    const fixture = makeZipFixture();
    const entries = await indexOf(fixture.bytes);
    // Corrupt one entry so its local-header / data read fails, leaving the
    // others intact. A localHeaderOffset past EOF makes the range read fail.
    const poisoned = entries.map((e) =>
      e.name === 'raw.bin' ? { ...e, localHeaderOffset: fixture.bytes.byteLength + 1000 } : e,
    );

    const stub = env.EXTRACT_WORKER.getByName('job-fanout-4:w0');
    const summary = await runInDurableObject(stub, async (instance) => {
      const worker = testable(instance);
      inject(worker, fixture.bytes);
      return worker.extractShard({
        jobId: 'job-fanout-4',
        workerIndex: 0,
        sourceUrl: 'https://simulated/archive.zip',
        prefix: 'job-fanout-4',
        entries: poisoned,
      });
    });

    // One failed, the rest succeeded — the shard summary is honest.
    expect(summary.failed).toBe(1);
    expect(summary.done).toBe(entries.length - 1);
    // The good files still landed.
    expect(await env.OUTPUT.get('job-fanout-4/hello.txt')).not.toBeNull();
  });
});

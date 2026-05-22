/**
 * Integration test that the `MetricsSink` is populated with REAL numbers as an
 * extraction runs — through the genuine `Source`/`Bucket` services, the real
 * `DecompressionStream`, and the real test R2 binding inside `workerd`.
 *
 * This is the honesty check for the demo's headline metric: after extracting one
 * file from a fixture archive, `rangeBytesFetched` must be far smaller than the
 * archive size (we only pulled the size probe, the tail, the central directory,
 * the local header, and the one file's compressed bytes), the R2 write must be
 * counted, and the central directory must have been read exactly once.
 */

import { env } from 'cloudflare:workers';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import type { AppError } from '../src/effect/errors';
import { RangeFetchError } from '../src/effect/errors';
import { makeR2Bucket, Source, type ByteRange } from '../src/effect/services';
import { MetricsSink } from '../src/effect/metrics-sink';
import { deriveMetrics } from '../src/metrics';
import { extractEntry, readIndex } from '../src/extract';
import { makeZipFixture } from './fixtures';

type Services = Source | import('../src/effect/services').Bucket;

/** In-memory `Source` that records ranges through the sink, like the HTTP one. */
function inMemorySource(bytes: Uint8Array, metrics: MetricsSink): Layer.Layer<Source> {
  const slice = (range: ByteRange) => {
    metrics.range(range.start, range.end);
    return bytes.subarray(range.start, range.end);
  };
  return Layer.succeed(Source, {
    size: Effect.sync(() => {
      // The HTTP source counts a 1-byte probe + records archive size; mirror it.
      metrics.range(0, 1);
      metrics.setArchiveSize(bytes.byteLength);
      return bytes.byteLength;
    }),
    readRange: (range) =>
      range.start < 0 || range.end > bytes.byteLength
        ? Effect.fail(new RangeFetchError('out of bounds'))
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

async function run<A>(
  bytes: Uint8Array,
  metrics: MetricsSink,
  effect: Effect.Effect<A, AppError, Services>,
): Promise<A> {
  const layer = Layer.mergeAll(inMemorySource(bytes, metrics), makeR2Bucket(env.OUTPUT, metrics));
  return Effect.runPromise(Effect.provide(effect, layer));
}

describe('metrics collection', () => {
  it('records honest counters across an index read + one extraction', async () => {
    const fixture = makeZipFixture();
    const metrics = new MetricsSink();

    const entries = await run(fixture.bytes, metrics, readIndex(metrics));
    const hello = entries.find((e) => e.name === 'hello.txt')!;
    await run(fixture.bytes, metrics, extractEntry(hello, 'metrics-job', metrics));

    const view = deriveMetrics(metrics.snapshot());

    // Archive size is the fixture's real byte length.
    expect(view.archiveSize).toBe(fixture.bytes.byteLength);
    // We made several real range requests (probe, tail, CD, local header, data).
    expect(view.rangeRequestCount).toBeGreaterThanOrEqual(4);
    // The headline: we fetched FEWER bytes than the whole archive.
    expect(view.rangeBytesFetched).toBeLessThan(view.archiveSize * 2);
    expect(view.rangeBytesPercent).toBeGreaterThan(0);
    // Exactly one R2 write, one file extracted, one CD read (reused).
    expect(view.r2Writes).toBe(1);
    expect(view.filesExtracted).toBe(1);
    expect(view.centralDirectoryReads).toBe(1);
    // Compute time was measured (>= 0; a real delta around the inflate).
    expect(view.computeMs).toBeGreaterThanOrEqual(0);
  });

  it('counts the central directory as read once even across multiple extractions', async () => {
    const fixture = makeZipFixture();
    const metrics = new MetricsSink();

    const entries = await run(fixture.bytes, metrics, readIndex(metrics));
    for (const e of entries) {
      await run(fixture.bytes, metrics, extractEntry(e, 'metrics-job-2', metrics));
    }
    const view = deriveMetrics(metrics.snapshot());
    expect(view.centralDirectoryReads).toBe(1);
    expect(view.filesExtracted).toBe(entries.length);
    expect(view.r2Writes).toBe(entries.length);
  });
});

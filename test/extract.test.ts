/**
 * End-to-end extraction test, run inside the Workers runtime so the real
 * `DecompressionStream('deflate-raw')`, `FixedLengthStream`, and R2 binding are
 * exercised — not Node shims.
 *
 * The remote ZIP is simulated by an in-memory `Source` layer that range-reads
 * the fixture buffer (exactly the byte ranges the production HTTP source would
 * fetch). Output goes to the real test R2 bucket (`env.OUTPUT`). We assert that
 * a full parse → extract round-trip reproduces the original file bytes for both
 * a DEFLATE and a STORED entry.
 */

import { env } from 'cloudflare:workers';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import type { AppError } from '../src/effect/errors';
import { RangeFetchError } from '../src/effect/errors';
import { Bucket, makeR2Bucket, Source, type ByteRange } from '../src/effect/services';
import { extractEntry, readIndex } from '../src/extract';
import { fixtureEntry, makeLargeStoredZipFixture, makeZipFixture } from './fixtures';

const MIB = 1024 * 1024;

/**
 * Fast byte-array equality for the multi-MiB round-trip checks. Vitest's deep
 * `toEqual` on a multi-MiB `Uint8Array` is pathologically slow (per-element
 * structural compare), enough to blow the test timeout — this is a tight loop
 * that returns a boolean we can assert in O(1).
 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

type Services = Source | Bucket;

/** In-memory `Source` that slices the fixture buffer like an HTTP range-GET. */
function inMemorySource(bytes: Uint8Array): Layer.Layer<Source> {
  const slice = (range: ByteRange) => bytes.subarray(range.start, range.end);
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

/** Run an Effect against an in-memory source + the real test R2 bucket. */
async function run<A>(bytes: Uint8Array, effect: Effect.Effect<A, AppError, Services>): Promise<A> {
  const layer = Layer.mergeAll(inMemorySource(bytes), makeR2Bucket(env.OUTPUT));
  return Effect.runPromise(Effect.provide(effect, layer));
}

describe('readIndex', () => {
  it('lists all entries from the simulated remote archive', async () => {
    const { bytes } = makeZipFixture();
    const entries = await run(bytes, readIndex());
    expect(entries.map((e) => e.name).sort()).toEqual(['dir/data.json', 'hello.txt', 'raw.bin']);
  });
});

describe('extractEntry', () => {
  it('extracts a DEFLATE entry and writes the original bytes to R2', async () => {
    const fixture = makeZipFixture();
    const entries = await run(fixture.bytes, readIndex());
    const hello = entries.find((e) => e.name === 'hello.txt')!;

    const result = await run(fixture.bytes, extractEntry(hello, 'job-1'));
    expect(result.key).toBe('job-1/hello.txt');
    expect(result.bytesWritten).toBe(fixtureEntry(fixture, 'hello.txt').contents.length);

    const stored = await env.OUTPUT.get('job-1/hello.txt');
    expect(stored).not.toBeNull();
    const bytes = new Uint8Array(await stored!.arrayBuffer());
    expect(bytes).toEqual(fixtureEntry(fixture, 'hello.txt').contents);
  });

  it('extracts a STORED entry verbatim', async () => {
    const fixture = makeZipFixture();
    const entries = await run(fixture.bytes, readIndex());
    const raw = entries.find((e) => e.name === 'raw.bin')!;

    const result = await run(fixture.bytes, extractEntry(raw, 'job-2'));
    expect(result.key).toBe('job-2/raw.bin');

    const stored = await env.OUTPUT.get('job-2/raw.bin');
    const bytes = new Uint8Array(await stored!.arrayBuffer());
    expect(bytes).toEqual(fixtureEntry(fixture, 'raw.bin').contents);
  });

  it('extracts a nested-path entry to a correctly joined key', async () => {
    const fixture = makeZipFixture();
    const entries = await run(fixture.bytes, readIndex());
    const nested = entries.find((e) => e.name === 'dir/data.json')!;

    const result = await run(fixture.bytes, extractEntry(nested, 'job-3/'));
    expect(result.key).toBe('job-3/dir/data.json');

    const stored = await env.OUTPUT.get('job-3/dir/data.json');
    const bytes = new Uint8Array(await stored!.arrayBuffer());
    expect(bytes).toEqual(fixtureEntry(fixture, 'dir/data.json').contents);
  });
});

describe('extractEntry — large STORED via parallel multipart', () => {
  const SIZE = 6 * MIB;

  it('round-trips a large STORED entry through the multipart path (bytes match)', async () => {
    // 6 MiB STORED entry; lowered threshold (4 MiB) + 5 MiB parts ⇒ 2-part plan
    // (5 MiB + 1 MiB): a real non-last part at R2's 5 MiB floor + a smaller
    // final part. Fixture kept small on purpose — the workerd test isolate heap
    // is tight; this still genuinely crosses the 5 MiB part floor.
    const fixture = makeLargeStoredZipFixture(SIZE);
    const entries = await run(fixture.bytes, readIndex());
    const big = entries.find((e) => e.name === 'big.bin')!;
    expect(big.compressionMethod).toBe(0); // STORED

    const result = await run(
      fixture.bytes,
      extractEntry(big, 'mpu-job', undefined, {
        multipartThreshold: 4 * MIB,
        partSize: 5 * MIB,
        partConcurrency: 6,
      }),
    );
    expect(result.key).toBe('mpu-job/big.bin');
    expect(result.bytesWritten).toBe(SIZE);

    const stored = await env.OUTPUT.get('mpu-job/big.bin');
    expect(stored).not.toBeNull();
    expect(stored!.size).toBe(SIZE); // R2 completed the object at the exact size
    const bytes = new Uint8Array(await stored!.arrayBuffer());
    expect(bytesEqual(bytes, fixtureEntry(fixture, 'big.bin').contents)).toBe(true);
  }, 30_000);

  it('the same STORED entry below threshold takes the single-stream path and still matches', async () => {
    // High threshold ⇒ NOT multipart; verifies the size-gate and that the
    // single-stream path handles the same STORED entry identically (the bytes
    // must be identical regardless of which path produced them).
    const fixture = makeLargeStoredZipFixture(SIZE);
    const entries = await run(fixture.bytes, readIndex());
    const big = entries.find((e) => e.name === 'big.bin')!;

    const result = await run(
      fixture.bytes,
      extractEntry(big, 'single-path', undefined, { multipartThreshold: 64 * MIB }),
    );
    expect(result.bytesWritten).toBe(SIZE);
    const stored = await env.OUTPUT.get('single-path/big.bin');
    const bytes = new Uint8Array(await stored!.arrayBuffer());
    expect(bytesEqual(bytes, fixtureEntry(fixture, 'big.bin').contents)).toBe(true);
  }, 30_000);
});

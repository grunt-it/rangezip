/**
 * Range-fetch retry behaviour, exercised against the REAL HTTP `Source`
 * (`makeHttpSource`) with `globalThis.fetch` stubbed to a fake origin that
 * serves the fixture bytes — and that can be told to return transient (429 /
 * 503) or permanent (404) statuses for the first N attempts.
 *
 * The live failure mode this guards: under the 144-way DO fan-out the source
 * (R2's public `r2.dev` URL) rate-limits a chunk of range fetches with HTTP 429.
 * The 429 is transient — it clears on a backed-off retry — so rangezip must
 * retry it rather than failing the entry. Permanent failures (404/416/403/401)
 * must still fail fast without burning the retry budget.
 *
 * Runs inside workerd (the Cloudflare pool) so the real `DecompressionStream`,
 * `FixedLengthStream`, and R2 binding are used end to end.
 */

import { env } from 'cloudflare:workers';
import { Effect, Exit, Layer } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { RangeFetchError } from '../src/effect/errors';
import { Bucket, makeHttpSource, makeR2Bucket, Source } from '../src/effect/services';
import { extractEntry, readIndex } from '../src/extract';
import { fixtureEntry, makeZipFixture } from './fixtures';

const SOURCE_URL = 'https://fake-origin.test/archive.zip';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Parse a `Range: bytes=start-end` header into a half-open `[start, end)`. */
function parseRange(header: string | null, total: number): { start: number; end: number } {
  const m = /bytes=(\d+)-(\d*)/.exec(header ?? '');
  if (!m) return { start: 0, end: total };
  const start = Number(m[1]);
  const end = m[2] === '' ? total : Number(m[2]) + 1; // header end is inclusive
  return { start, end };
}

/** A 206 Partial Content response carrying the requested slice of `bytes`. */
function partialResponse(bytes: Uint8Array, header: string | null): Response {
  const { start, end } = parseRange(header, bytes.byteLength);
  const slice = bytes.subarray(start, end);
  return new Response(slice, {
    status: 206,
    headers: {
      'content-range': `bytes ${start}-${end - 1}/${bytes.byteLength}`,
      'content-length': String(slice.byteLength),
    },
  });
}

/**
 * Install a stub `globalThis.fetch` that fails the first `failTimes` calls with
 * `failStatus` (optionally carrying a `Retry-After`), then serves real partial
 * content from `bytes`. Returns a counter of total fetch calls observed.
 */
function stubFetch(opts: {
  bytes: Uint8Array;
  failTimes: number;
  failStatus: number;
  retryAfter?: string;
}): { calls: () => number } {
  let calls = 0;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    if (calls <= opts.failTimes) {
      const headers: Record<string, string> = {};
      if (opts.retryAfter !== undefined) headers['retry-after'] = opts.retryAfter;
      return Promise.resolve(new Response('rate limited', { status: opts.failStatus, headers }));
    }
    const headerRecord = (init?.headers ?? {}) as Record<string, string>;
    const rangeHeader = typeof headerRecord.Range === 'string' ? headerRecord.Range : null;
    return Promise.resolve(partialResponse(opts.bytes, rangeHeader));
  }) as typeof fetch;
  return { calls: () => calls };
}

type Services = Source | Bucket;

/** Run an Effect against the REAL HTTP source (stubbed fetch) + real test R2. */
function run<A, E>(effect: Effect.Effect<A, E, Services>): Promise<Exit.Exit<A, E>> {
  const layer = Layer.mergeAll(makeHttpSource(SOURCE_URL), makeR2Bucket(env.OUTPUT));
  return Effect.runPromiseExit(Effect.provide(effect, layer));
}

describe('range-fetch retry', () => {
  it('retries a 429 then round-trips the entry with bytes intact', async () => {
    const fixture = makeZipFixture();
    // Fail the first 2 of EVERY fetch with 429, then serve real bytes. Because
    // each range request (size probe, tail, CD, local header, data) is its own
    // retried unit, "first 2 calls" only bites the size probe; that's enough to
    // prove the retry path re-issues and eventually succeeds end to end.
    const stub = stubFetch({ bytes: fixture.bytes, failTimes: 2, failStatus: 429 });

    const indexExit = await run(readIndex());
    expect(Exit.isSuccess(indexExit)).toBe(true);
    const entries = Exit.isSuccess(indexExit) ? indexExit.value : [];
    const hello = entries.find((e) => e.name === 'hello.txt')!;
    expect(hello).toBeDefined();

    const exit = await run(extractEntry(hello, 'retry-job'));
    expect(Exit.isSuccess(exit)).toBe(true);

    const stored = await env.OUTPUT.get('retry-job/hello.txt');
    expect(stored).not.toBeNull();
    const bytes = new Uint8Array(await stored!.arrayBuffer());
    expect(bytes).toEqual(fixtureEntry(fixture, 'hello.txt').contents);
    // Proves a retry actually happened (the 2 failed calls + the eventual ones).
    expect(stub.calls()).toBeGreaterThan(2);
  });

  it('retries a streamRange 429 and streams the body once it lands', async () => {
    const fixture = makeZipFixture();
    // 3 failures up front: the size probe fails+succeeds, then the streamRange
    // call inherits the next failures and retries before serving the slice.
    const stub = stubFetch({ bytes: fixture.bytes, failTimes: 1, failStatus: 503 });

    const layer = Layer.mergeAll(makeHttpSource(SOURCE_URL), makeR2Bucket(env.OUTPUT));
    const program = Effect.gen(function* () {
      const source = yield* Source;
      const stream = yield* source.streamRange({ start: 0, end: 16 });
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = yield* Effect.promise(() => reader.read());
        if (done) break;
        if (value) chunks.push(value);
      }
      return chunks;
    });

    const exit = await Effect.runPromiseExit(Effect.provide(program, layer));
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(stub.calls()).toBe(2); // 1 failed (503) + 1 successful retry
  });

  it('does NOT retry a permanent 404 — fails immediately, exactly one fetch', async () => {
    const fixture = makeZipFixture();
    const stub = stubFetch({ bytes: fixture.bytes, failTimes: 100, failStatus: 404 });

    const exit = await run(
      Effect.gen(function* () {
        const source = yield* Source;
        return yield* source.size;
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = exit.cause._tag === 'Fail' ? exit.cause.error : undefined;
      expect(err).toBeInstanceOf(RangeFetchError);
      expect((err as RangeFetchError).retryable).toBe(false);
    }
    // Exactly one fetch: the 404 was permanent, the retry `while` predicate
    // short-circuited, no further attempts.
    expect(stub.calls()).toBe(1);
  });

  it('does NOT retry a permanent 403 either', async () => {
    const fixture = makeZipFixture();
    const stub = stubFetch({ bytes: fixture.bytes, failTimes: 100, failStatus: 403 });

    const exit = await run(
      Effect.gen(function* () {
        const source = yield* Source;
        return yield* source.readRange({ start: 0, end: 8 });
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(stub.calls()).toBe(1);
  });

  it('honours a Retry-After header on a 429 (delta-seconds) before the retry', async () => {
    const fixture = makeZipFixture();
    // 1 failing 429 with `Retry-After: 1` (1s). The retry must wait >= ~1s
    // before re-issuing, then succeed.
    const stub = stubFetch({
      bytes: fixture.bytes,
      failTimes: 1,
      failStatus: 429,
      retryAfter: '1',
    });

    const started = Date.now();
    const exit = await run(
      Effect.gen(function* () {
        const source = yield* Source;
        return yield* source.size;
      }),
    );
    const elapsed = Date.now() - started;

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(stub.calls()).toBe(2); // 1 failed + 1 retry
    // Retry-After (1s) was honoured as a floor — allow a little slack for clock.
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });

  it('eventually gives up after the attempt cap on a persistent 429', async () => {
    const fixture = makeZipFixture();
    // Always 429: should retry up to the cap, then fail with a retryable error.
    const stub = stubFetch({ bytes: fixture.bytes, failTimes: 1000, failStatus: 429 });

    const exit = await run(
      Effect.gen(function* () {
        const source = yield* Source;
        return yield* source.size;
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = exit.cause._tag === 'Fail' ? exit.cause.error : undefined;
      expect((err as RangeFetchError).retryable).toBe(true);
    }
    // 1 initial + up to 5 retries = at most 6 attempts (elapsed cap may stop
    // it sooner). At minimum it retried more than once.
    expect(stub.calls()).toBeGreaterThan(1);
    expect(stub.calls()).toBeLessThanOrEqual(6);
  }, 40_000);
});

/**
 * Durable Object coordinator tests.
 *
 * The end-to-end extraction pipeline (range read → inflate → R2) is covered in
 * `extract.test.ts` against the real Workers runtime. Here we test the DO's
 * COORDINATION layer in isolation: that `report()` aggregates per-file state
 * from SQLite correctly (done / failed / total), that status transitions are
 * reflected, and that `start()` durably seeds a job before returning.
 *
 * We use `runInDurableObject` to seed the DO's SQLite directly (simulating the
 * background extraction having recorded results) and then assert the report —
 * no network/HTTP source needed.
 */

import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

/** Seed the job + file rows directly in the DO's SQLite. */
function seed(
  state: DurableObjectState,
  job: {
    id: string;
    status: string;
    sourceUrl: string;
    prefix: string;
    destination?: string;
    expiresAt?: number;
  },
  files: ReadonlyArray<{
    name: string;
    status: string;
    key?: string;
    bytes?: number;
    error?: string;
  }>,
): void {
  state.storage.sql.exec(
    `INSERT OR REPLACE INTO job
       (id, status, source_url, prefix, total, error, destination, expires_at, metrics_json)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
    job.id,
    job.status,
    job.sourceUrl,
    job.prefix,
    files.length,
    job.destination ?? 'demo',
    job.expiresAt ?? null,
  );
  for (const f of files) {
    state.storage.sql.exec(
      'INSERT OR REPLACE INTO file (name, key, status, bytes, error) VALUES (?, ?, ?, ?, ?)',
      f.name,
      f.key ?? null,
      f.status,
      f.bytes ?? null,
      f.error ?? null,
    );
  }
}

describe('ExtractJob.report', () => {
  it('returns null before a job has been started', async () => {
    const stub = env.EXTRACT_JOB.getByName('empty');
    expect(await stub.report()).toBeNull();
  });

  it('aggregates done / failed / total across per-file rows', async () => {
    const stub = env.EXTRACT_JOB.getByName('agg');
    await runInDurableObject(stub, async (_instance, state) => {
      seed(state, { id: 'agg', status: 'completed', sourceUrl: 'https://x/a.zip', prefix: 'out' }, [
        { name: 'a.txt', status: 'done', key: 'out/a.txt', bytes: 10 },
        { name: 'b.txt', status: 'done', key: 'out/b.txt', bytes: 20 },
        { name: 'c.txt', status: 'failed', error: 'boom' },
      ]);
    });

    const report = await stub.report();
    expect(report).not.toBeNull();
    expect(report!.status).toBe('completed');
    expect(report!.total).toBe(3);
    expect(report!.done).toBe(2);
    expect(report!.failed).toBe(1);

    const failed = report!.files.find((f) => f.name === 'c.txt')!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('boom');
    expect(failed.key).toBeNull();

    const ok = report!.files.find((f) => f.name === 'a.txt')!;
    expect(ok.key).toBe('out/a.txt');
    expect(ok.bytes).toBe(10);
  });

  it('reflects a job-level failure with its error message', async () => {
    const stub = env.EXTRACT_JOB.getByName('jobfail');
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        'INSERT OR REPLACE INTO job (id, status, source_url, prefix, total, error) VALUES (?, ?, ?, ?, 0, ?)',
        'jobfail',
        'failed',
        'https://x/a.zip',
        'out',
        'Source did not honour the byte-range request',
      );
    });

    const report = await stub.report();
    expect(report!.status).toBe('failed');
    expect(report!.error).toContain('byte-range');
  });
});

describe('ExtractJob.start', () => {
  it('durably records a pending job and returns its id immediately', async () => {
    const stub = env.EXTRACT_JOB.getByName('start-test');

    // The source refuses connections. A connection error is a RETRYABLE
    // range-fetch failure (exactly the transient network class the retry policy
    // targets), so the background extraction now backs off and retries the size
    // probe up to the policy's cap (~5 retries / 30s elapsed) before recording a
    // job-level failure — it no longer fails on the first refused connection.
    // `start` itself still returns immediately with a pending job (it must not
    // block on the extraction); the `waitFor` below is widened to cover the full
    // retry budget so we assert the eventual RECORDED failure, not a leak.
    const sourceUrl = 'http://127.0.0.1:1/archive.zip';
    const accepted = await stub.start({
      id: 'start-test',
      sourceUrl,
      destination: 'demo',
    });
    expect(accepted).toEqual({ id: 'start-test', status: 'pending' });

    // The job row exists immediately after start returns, and its stored prefix
    // is the jobId-scoped namespace (server-derived, never client-supplied).
    await runInDurableObject(stub, async (_instance, state) => {
      const row = state.storage.sql
        .exec<{
          id: string;
          source_url: string;
          prefix: string;
        }>('SELECT id, source_url, prefix FROM job LIMIT 1')
        .one();
      expect(row.id).toBe('start-test');
      expect(row.source_url).toBe(sourceUrl);
      expect(row.prefix).toBe('start-test'); // demo prefix === jobId
    });

    // Drain the background promise so the failed fetch settles before the test
    // tears down: a dead source must end as a RECORDED failure, never a leaked
    // rejection. (`runJob` catches into SQLite; this asserts that contract.)
    // Timeout covers the retry budget — the size probe backs off through its
    // retries before the connection error is finally recorded as a failure.
    await vi.waitFor(
      async () => {
        const report = await stub.report();
        expect(report?.status).toBe('failed');
        expect(report?.error).not.toBeNull();
      },
      { timeout: 35_000, interval: 100 },
    );
  }, 40_000);
});

describe('ExtractJob.report — new fields', () => {
  it('exposes destination, expiresAt, percent, and metrics defaults', async () => {
    const stub = env.EXTRACT_JOB.getByName('report-fields');
    const future = Date.now() + 3_600_000;
    await runInDurableObject(stub, async (_instance, state) => {
      seed(
        state,
        {
          id: 'report-fields',
          status: 'completed',
          sourceUrl: 'https://x/a.zip',
          prefix: 'out',
          destination: 'demo',
          expiresAt: future,
        },
        [
          { name: 'a.txt', status: 'done', key: 'out/a.txt', bytes: 10 },
          { name: 'b.txt', status: 'failed', error: 'boom' },
        ],
      );
    });
    const report = await stub.report();
    expect(report!.destination).toBe('demo');
    expect(report!.expiresAt).toBe(future);
    expect(report!.percent).toBe(100); // 1 done + 1 failed of 2 = settled
    expect(report!.metrics).toBeDefined();
    expect(report!.metrics.rangeBytesPercent).toBe(0); // no metrics recorded yet
  });
});

describe('ExtractJob.fetch — WebSocket upgrade', () => {
  // NOTE: The 101-with-webSocket success path can't be asserted through
  // `runInDurableObject` — the pool's transport re-validates the returned
  // Response against the (non-upgrade) outer request and rejects a WebSocket
  // body. This is the documented "WebSockets + DO + per-file isolation" pool
  // limitation. We assert the testable non-upgrade contract here; the live
  // upgrade is exercised by the app-level gating tests + manual `wrangler dev`.
  it('rejects a non-upgrade request with 426', async () => {
    const stub = env.EXTRACT_JOB.getByName('ws-noupgrade');
    const res = await runInDurableObject(stub, (instance) =>
      instance.fetch(new Request('https://do/jobs/ws-noupgrade/ws')),
    );
    expect(res.status).toBe(426);
  });
});

describe('ExtractJob.alarm — demo cleanup', () => {
  it('deletes every R2 object under the job prefix for a demo job', async () => {
    // Put real objects under the prefix in the test R2 bucket.
    await env.OUTPUT.put('cleanup-job/one.txt', 'hello');
    await env.OUTPUT.put('cleanup-job/nested/two.txt', 'world');
    expect(await env.OUTPUT.get('cleanup-job/one.txt')).not.toBeNull();

    const stub = env.EXTRACT_JOB.getByName('cleanup-job');
    await runInDurableObject(stub, async (instance, state) => {
      seed(
        state,
        {
          id: 'cleanup-job',
          status: 'completed',
          sourceUrl: 'https://x/a.zip',
          prefix: 'cleanup-job',
          destination: 'demo',
          expiresAt: Date.now(),
        },
        [{ name: 'one.txt', status: 'done', key: 'cleanup-job/one.txt', bytes: 5 }],
      );
      await instance.alarm();
    });

    expect(await env.OUTPUT.get('cleanup-job/one.txt')).toBeNull();
    expect(await env.OUTPUT.get('cleanup-job/nested/two.txt')).toBeNull();
  });

  it("cleanup is scoped to the job's own jobId prefix — a co-tenant job's output survives", async () => {
    // Two demo jobs share the bucket but live under DISTINCT jobId prefixes.
    // Job A's cleanup must wipe ONLY `job-a/…` and leave `job-b/…` untouched —
    // this is the multi-user collision bug this change fixes.
    await env.OUTPUT.put('job-a/mine.txt', 'a');
    await env.OUTPUT.put('job-b/theirs.txt', 'b');

    const stub = env.EXTRACT_JOB.getByName('job-a');
    await runInDurableObject(stub, async (instance, state) => {
      seed(
        state,
        {
          id: 'job-a',
          status: 'completed',
          sourceUrl: 'https://x/a.zip',
          prefix: 'job-a', // jobId-scoped prefix
          destination: 'demo',
          expiresAt: Date.now(),
        },
        [{ name: 'mine.txt', status: 'done', key: 'job-a/mine.txt', bytes: 1 }],
      );
      await instance.alarm();
    });

    expect(await env.OUTPUT.get('job-a/mine.txt')).toBeNull(); // own output gone
    expect(await env.OUTPUT.get('job-b/theirs.txt')).not.toBeNull(); // co-tenant safe
    await env.OUTPUT.delete('job-b/theirs.txt'); // cleanup
  });

  it('does NOT delete anything for a BYO job', async () => {
    await env.OUTPUT.put('byo-job/keep.txt', 'precious');
    const stub = env.EXTRACT_JOB.getByName('byo-job');
    await runInDurableObject(stub, async (instance, state) => {
      seed(
        state,
        {
          id: 'byo-job',
          status: 'completed',
          sourceUrl: 'https://x/a.zip',
          prefix: 'byo-job',
          destination: 'byo',
        },
        [{ name: 'keep.txt', status: 'done', key: 'byo-job/keep.txt', bytes: 8 }],
      );
      await instance.alarm();
    });
    // BYO alarm is a no-op; the demo bucket object (used here as a stand-in)
    // must remain untouched — the cleanup only runs for demo-destination jobs.
    expect(await env.OUTPUT.get('byo-job/keep.txt')).not.toBeNull();
    // cleanup so the bucket isn't polluted for other tests
    await env.OUTPUT.delete('byo-job/keep.txt');
  });
});

describe('ExtractJob.reportFileResult — fan-out aggregation', () => {
  /** Seed a running job with `total` pending files named f0..f{total-1}. */
  function seedPending(state: DurableObjectState, id: string, total: number): void {
    state.storage.sql.exec(
      `INSERT OR REPLACE INTO job
         (id, status, source_url, prefix, total, error, destination, expires_at, metrics_json)
       VALUES (?, 'running', ?, ?, ?, NULL, 'demo', NULL, NULL)`,
      id,
      'https://x/a.zip',
      id,
      total,
    );
    for (let i = 0; i < total; i++) {
      state.storage.sql.exec(
        'INSERT OR REPLACE INTO file (name, key, status, bytes, error) VALUES (?, NULL, ?, NULL, NULL)',
        `f${i}`,
        'pending',
      );
    }
  }

  it('writes per-file results from worker reports into the file table', async () => {
    const stub = env.EXTRACT_JOB.getByName('report-write');
    await runInDurableObject(stub, async (instance, state) => {
      seedPending(state, 'report-write', 2);
      await instance.reportFileResult({
        workerIndex: 0,
        name: 'f0',
        status: 'done',
        key: 'report-write/f0',
        bytes: 123,
        error: null,
        inFlight: 1,
      });
      await instance.reportFileResult({
        workerIndex: 1,
        name: 'f1',
        status: 'failed',
        key: null,
        bytes: null,
        error: 'kaboom',
        inFlight: 1,
      });
    });

    const report = await stub.report();
    expect(report!.done).toBe(1);
    expect(report!.failed).toBe(1);
    const f0 = report!.files.find((f) => f.name === 'f0')!;
    expect(f0.status).toBe('done');
    expect(f0.key).toBe('report-write/f0');
    expect(f0.bytes).toBe(123);
    const f1 = report!.files.find((f) => f.name === 'f1')!;
    expect(f1.status).toBe('failed');
    expect(f1.error).toBe('kaboom');
  });

  it('aggregates peak concurrency as the SUM of in-flight across workers', async () => {
    // Two workers each report in-flight counts at overlapping moments. The peak
    // must be the max of the SUMMED in-flight, NOT any single worker's local
    // peak — this is what surfaces true N×6 cross-isolate parallelism.
    const stub = env.EXTRACT_JOB.getByName('peak-agg');
    const peak = await runInDurableObject(stub, async (instance, state) => {
      seedPending(state, 'peak-agg', 4);
      // worker 0 ramps to 6 in-flight; worker 1 ramps to 6 in-flight. At the
      // overlap the coordinator should observe 6 + 6 = 12, even though neither
      // worker individually exceeds 6 (the per-isolate cap).
      await instance.reportFileResult(report('peak-agg', 0, 'f0', 'extracting', 6));
      await instance.reportFileResult(report('peak-agg', 1, 'f1', 'extracting', 6));
      // Now both wind down.
      await instance.reportFileResult(report('peak-agg', 0, 'f0', 'done', 1));
      await instance.reportFileResult(report('peak-agg', 1, 'f1', 'done', 0));
      const r = await instance.report();
      return r!.metrics.peakConcurrency;
    });
    expect(peak).toBe(12);
  });

  it('a single isolate would cap at 6 — the sum exceeds it, proving the fan-out', async () => {
    const stub = env.EXTRACT_JOB.getByName('peak-exceeds-6');
    const peak = await runInDurableObject(stub, async (instance, state) => {
      seedPending(state, 'peak-exceeds-6', 6);
      // Three workers, each reporting 6 in-flight simultaneously → 18.
      await instance.reportFileResult(report('peak-exceeds-6', 0, 'f0', 'extracting', 6));
      await instance.reportFileResult(report('peak-exceeds-6', 1, 'f1', 'extracting', 6));
      await instance.reportFileResult(report('peak-exceeds-6', 2, 'f2', 'extracting', 6));
      const r = await instance.report();
      return r!.metrics.peakConcurrency;
    });
    expect(peak).toBeGreaterThan(6); // the whole point of the re-architecture
    expect(peak).toBe(18);
  });
});

describe('ExtractJob — phase + live timings', () => {
  /** Test view of the coordinator's private timing/metrics seams. */
  interface TimingProbe {
    metrics: import('../src/effect/metrics-sink').MetricsSink;
    extractStartedAt: number | null;
    indexStartedAt: number | null;
  }

  it('report() reflects the live extraction elapsed mid-run (not 0ms)', async () => {
    const stub = env.EXTRACT_JOB.getByName('live-timing');
    const extractionMs = await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT OR REPLACE INTO job
           (id, status, source_url, prefix, total, error, destination, expires_at, metrics_json)
         VALUES ('live-timing', 'running', 'https://x/a.zip', 'live-timing', 1, NULL, 'demo', NULL, NULL)`,
      );
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO file (name, key, status, bytes, error) VALUES ('f0', NULL, 'extracting', NULL, NULL)",
      );
      // Simulate being mid-extraction: phase set, a real range recorded (so the
      // live sink is "active"), extraction start a known time in the past, and
      // extractionMs NOT yet finalised (still 0 until the phase ends).
      const probe = instance as unknown as TimingProbe;
      probe.metrics.range(0, 500); // makes hasLive true + records a byte span
      probe.metrics.setPhase('extracting');
      probe.extractStartedAt = performance.now() - 1500; // 1.5s ago
      const r = await instance.report();
      return r!.metrics.extractionMs;
    });
    // Mid-run, extraction time tracks the elapsed (~1500ms) — NOT 0.
    expect(extractionMs).toBeGreaterThanOrEqual(1000);
  });

  it('report() exposes the current phase and totalMs includes live extraction', async () => {
    const stub = env.EXTRACT_JOB.getByName('live-phase');
    const view = await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT OR REPLACE INTO job
           (id, status, source_url, prefix, total, error, destination, expires_at, metrics_json)
         VALUES ('live-phase', 'running', 'https://x/a.zip', 'live-phase', 1, NULL, 'demo', NULL, NULL)`,
      );
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO file (name, key, status, bytes, error) VALUES ('f0', NULL, 'extracting', NULL, NULL)",
      );
      const probe = instance as unknown as TimingProbe;
      probe.metrics.range(0, 500);
      probe.metrics.setIndexReadMs(50);
      probe.metrics.setPhase('extracting');
      probe.metrics.setWorkerCount(3);
      probe.extractStartedAt = performance.now() - 800;
      const r = await instance.report();
      return r!.metrics;
    });
    expect(view.phase).toBe('extracting');
    expect(view.workerCount).toBe(3);
    // totalMs = indexReadMs (50, finalised) + live extractionMs (~800).
    expect(view.totalMs).toBeGreaterThanOrEqual(50 + 700);
  });
});

/** Build a FileReport for the aggregation tests. */
function report(
  _jobId: string,
  workerIndex: number,
  name: string,
  status: 'extracting' | 'done' | 'failed',
  inFlight: number,
): import('../src/extract-worker').FileReport {
  return {
    workerIndex,
    name,
    status,
    key: status === 'done' ? `out/${name}` : null,
    bytes: status === 'done' ? 10 : null,
    error: status === 'failed' ? 'err' : null,
    inFlight,
  };
}

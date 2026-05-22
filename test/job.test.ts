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

    // The source refuses connections, so the background extraction fails fast
    // and records a job-level failure — but `start` itself returns immediately
    // with a pending job (it must not block on the extraction).
    const sourceUrl = 'http://127.0.0.1:1/archive.zip';
    const accepted = await stub.start({
      id: 'start-test',
      sourceUrl,
      prefix: 'out',
      destination: 'demo',
    });
    expect(accepted).toEqual({ id: 'start-test', status: 'pending' });

    // The job row exists immediately after start returns.
    await runInDurableObject(stub, async (_instance, state) => {
      const row = state.storage.sql
        .exec<{ id: string; source_url: string }>('SELECT id, source_url FROM job LIMIT 1')
        .one();
      expect(row.id).toBe('start-test');
      expect(row.source_url).toBe(sourceUrl);
    });

    // Drain the background promise so the failed fetch settles before the test
    // tears down: a dead source must end as a RECORDED failure, never a leaked
    // rejection. (`runJob` catches into SQLite; this asserts that contract.)
    await vi.waitFor(
      async () => {
        const report = await stub.report();
        expect(report?.status).toBe('failed');
        expect(report?.error).not.toBeNull();
      },
      { timeout: 5000, interval: 25 },
    );
  });
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

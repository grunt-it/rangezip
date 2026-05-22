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
  job: { id: string; status: string; sourceUrl: string; prefix: string },
  files: ReadonlyArray<{
    name: string;
    status: string;
    key?: string;
    bytes?: number;
    error?: string;
  }>,
): void {
  state.storage.sql.exec(
    'INSERT OR REPLACE INTO job (id, status, source_url, prefix, total, error) VALUES (?, ?, ?, ?, ?, NULL)',
    job.id,
    job.status,
    job.sourceUrl,
    job.prefix,
    files.length,
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
    const accepted = await stub.start({ id: 'start-test', sourceUrl, prefix: 'out' });
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

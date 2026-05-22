/**
 * Registry Durable Object tests — the SQLite-backed source of truth for access
 * codes + usage events. These drive the real DO through its namespace (the
 * `REGISTRY` binding from the Workers pool), exercising the actual SQLite schema
 * and RPC methods rather than the pure reducers (those are covered in
 * `registry-codes.test.ts`).
 *
 * Each test uses a distinct DO instance via `getByName` so state doesn't leak
 * across tests — except where a test deliberately re-uses one to assert
 * accumulation. Production always addresses the singleton `REGISTRY_NAME`.
 */

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from '../src/registry/codes';

describe('Registry.createCode + validateCode', () => {
  // Generous timeout: the FIRST Registry DO instantiation in a full-suite run
  // pays the workerd module-load + DO-construction cold start under parallel
  // import contention. Subsequent tests reuse the warm isolate and are fast.
  it('creates an active code that validates, with its label', { timeout: 20_000 }, async () => {
    const reg = env.REGISTRY.getByName('reg-create');
    const { code, label } = await reg.createCode('  My Label  ');
    expect(code).toMatch(/^[0-9A-Za-z]{10}$/);
    expect(label).toBe('My Label'); // trimmed

    const v = await reg.validateCode(code);
    expect(v).toEqual({ ok: true, label: 'My Label' });
  });

  it('rejects an unknown code', async () => {
    const reg = env.REGISTRY.getByName('reg-unknown');
    expect(await reg.validateCode('nope-nope-no')).toEqual({ ok: false });
  });

  it('rejects an empty / whitespace submission', async () => {
    const reg = env.REGISTRY.getByName('reg-empty');
    expect(await reg.validateCode('')).toEqual({ ok: false });
    expect(await reg.validateCode('   ')).toEqual({ ok: false });
  });

  it('trims the submitted code before matching', async () => {
    const reg = env.REGISTRY.getByName('reg-trim');
    const { code } = await reg.createCode('t');
    expect((await reg.validateCode(`  ${code}  `)).ok).toBe(true);
  });
});

describe('Registry.revokeCode', () => {
  it('a revoked code no longer validates', async () => {
    const reg = env.REGISTRY.getByName('reg-revoke');
    const { code } = await reg.createCode('to revoke');
    expect((await reg.validateCode(code)).ok).toBe(true);
    expect(await reg.revokeCode(code)).toEqual({ ok: true });
    expect(await reg.validateCode(code)).toEqual({ ok: false });
  });

  it('is idempotent and reports ok:false for an unknown code', async () => {
    const reg = env.REGISTRY.getByName('reg-revoke-idem');
    const { code } = await reg.createCode('x');
    await reg.revokeCode(code);
    await reg.revokeCode(code); // no throw, still fine
    expect((await reg.validateCode(code)).ok).toBe(false);
    expect(await reg.revokeCode('does-not-exist')).toEqual({ ok: false });
  });
});

describe('Registry.recordEvent + listCodes aggregation', () => {
  it('aggregates sessions, jobs, files, and bytes per code', async () => {
    const reg = env.REGISTRY.getByName('reg-usage');
    const { code } = await reg.createCode('usage code');

    await reg.recordEvent(code, EVENT_TYPES.sessionStart, {});
    await reg.recordEvent(code, EVENT_TYPES.jobStarted, { source: 'url', requestedFiles: 2 });
    await reg.recordEvent(code, EVENT_TYPES.jobCompleted, {
      filesExtracted: 2,
      bytes: 2048,
      percentOfArchive: 0.5,
      durationMs: 300,
    });

    const codes = await reg.listCodes();
    const row = codes.find((c) => c.code === code);
    expect(row).toBeDefined();
    expect(row!.redeemed).toBe(true);
    expect(row!.sessions).toBe(1);
    expect(row!.jobs).toBe(1);
    expect(row!.filesExtracted).toBe(2);
    expect(row!.bytes).toBe(2048);
    expect(row!.lastActiveAt).not.toBeNull();
  });

  it('lists newest-first and shows un-redeemed codes with zero usage', async () => {
    const reg = env.REGISTRY.getByName('reg-list-order');
    const first = await reg.createCode('first');
    const second = await reg.createCode('second');
    const codes = await reg.listCodes();
    // Newest (second) appears before first.
    const idxSecond = codes.findIndex((c) => c.code === second.code);
    const idxFirst = codes.findIndex((c) => c.code === first.code);
    expect(idxSecond).toBeLessThan(idxFirst);
    const firstRow = codes.find((c) => c.code === first.code)!;
    expect(firstRow.redeemed).toBe(false);
    expect(firstRow.sessions).toBe(0);
  });
});

describe('Registry.codeTimeline', () => {
  it('returns events oldest-first with parsed detail', async () => {
    const reg = env.REGISTRY.getByName('reg-timeline');
    const { code } = await reg.createCode('tl');
    await reg.recordEvent(code, EVENT_TYPES.sessionStart, {});
    await reg.recordEvent(code, EVENT_TYPES.jobStarted, {
      source: 'sample-2gb',
      requestedFiles: 5,
    });

    const events = await reg.codeTimeline(code);
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe(EVENT_TYPES.sessionStart);
    expect(events[1]!.type).toBe(EVENT_TYPES.jobStarted);
    expect(events[1]!.detail).toEqual({ source: 'sample-2gb', requestedFiles: 5 });
    // ascending by time
    expect(events[0]!.at).toBeLessThanOrEqual(events[1]!.at);
  });

  it('is empty for a code with no events', async () => {
    const reg = env.REGISTRY.getByName('reg-timeline-empty');
    const { code } = await reg.createCode('quiet');
    expect(await reg.codeTimeline(code)).toEqual([]);
  });
});

/**
 * Pure registry-logic tests: code generation (shape, alphabet, uniqueness,
 * length) and the usage-aggregation reducer (`aggregateUsage`) that turns a
 * code's raw events into the admin summary. No runtime needed — these run
 * against in-memory data, matching the repo's pure-logic-vs-shell discipline.
 * (They run inside the Workers pool so `crypto.getRandomValues` is the real one.)
 */

import { describe, expect, it } from 'vitest';
import {
  aggregateUsage,
  DEFAULT_CODE_LENGTH,
  EVENT_TYPES,
  generateCode,
  isCodeActive,
  type CodeRecord,
  type DetailObject,
  type UsageEvent,
} from '../src/registry/codes';

const ALPHABET_RE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz]+$/;

describe('generateCode', () => {
  it('produces a default-length code over the URL-safe alphabet', () => {
    const code = generateCode();
    expect(code).toHaveLength(DEFAULT_CODE_LENGTH);
    expect(code).toMatch(ALPHABET_RE);
    // No ambiguous chars / no url-unsafe chars.
    expect(code).not.toMatch(/[01OIl+/=]/);
  });

  it('honours a custom length', () => {
    expect(generateCode(16)).toHaveLength(16);
    expect(generateCode(4)).toHaveLength(4);
  });

  it('is overwhelmingly likely to be unique (no collisions across many draws)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateCode());
    expect(seen.size).toBe(1000);
  });
});

describe('isCodeActive', () => {
  const base: CodeRecord = { code: 'abc', label: 'x', createdAt: 1, revokedAt: null };
  it('is true for an existing, non-revoked code', () => {
    expect(isCodeActive(base)).toBe(true);
  });
  it('is false for a revoked code', () => {
    expect(isCodeActive({ ...base, revokedAt: 999 })).toBe(false);
  });
  it('is false for a missing record', () => {
    expect(isCodeActive(null)).toBe(false);
    expect(isCodeActive(undefined)).toBe(false);
  });
});

describe('aggregateUsage', () => {
  const record: CodeRecord = {
    code: 'CODE12345X',
    label: 'Acme',
    createdAt: 1000,
    revokedAt: null,
  };
  const ev = (type: string, at: number, detail: DetailObject | null = null): UsageEvent => ({
    id: at,
    code: record.code,
    type,
    detail,
    at,
  });

  it('reports zero usage for a code with no events', () => {
    const s = aggregateUsage(record, []);
    expect(s.redeemed).toBe(false);
    expect(s.lastActiveAt).toBeNull();
    expect(s.sessions).toBe(0);
    expect(s.jobs).toBe(0);
    expect(s.filesExtracted).toBe(0);
    expect(s.bytes).toBe(0);
    // passes through the record fields
    expect(s.label).toBe('Acme');
    expect(s.code).toBe('CODE12345X');
  });

  it('counts sessions and jobs, sums files + bytes from completions', () => {
    const events: UsageEvent[] = [
      ev(EVENT_TYPES.sessionStart, 1100),
      ev(EVENT_TYPES.sessionStart, 1200),
      ev(EVENT_TYPES.jobStarted, 1300, { source: 'url', requestedFiles: 3 }),
      ev(EVENT_TYPES.jobCompleted, 1500, {
        filesExtracted: 3,
        bytes: 4096,
        percentOfArchive: 1.2,
        durationMs: 800,
      }),
      ev(EVENT_TYPES.jobStarted, 1600, { source: 'sample-2gb', requestedFiles: 1 }),
      ev(EVENT_TYPES.jobCompleted, 1900, {
        filesExtracted: 1,
        bytes: 1000,
        percentOfArchive: 0.1,
        durationMs: 200,
      }),
    ];
    const s = aggregateUsage(record, events);
    expect(s.redeemed).toBe(true);
    expect(s.sessions).toBe(2);
    expect(s.jobs).toBe(2);
    expect(s.filesExtracted).toBe(4);
    expect(s.bytes).toBe(5096);
    expect(s.lastActiveAt).toBe(1900);
  });

  it('takes lastActiveAt as the max regardless of event order', () => {
    const events = [ev(EVENT_TYPES.jobStarted, 5000), ev(EVENT_TYPES.sessionStart, 2000)];
    expect(aggregateUsage(record, events).lastActiveAt).toBe(5000);
  });

  it('ignores malformed / negative numeric details (defensive)', () => {
    const events: UsageEvent[] = [
      // negative count + a non-numeric bytes value are both ignored
      ev(EVENT_TYPES.jobCompleted, 1, { filesExtracted: -5, bytes: 'lots' }),
      ev(EVENT_TYPES.jobCompleted, 2, { filesExtracted: 2, bytes: 100 }),
      ev(EVENT_TYPES.jobCompleted, 3, null),
    ];
    const s = aggregateUsage(record, events);
    expect(s.filesExtracted).toBe(2);
    expect(s.bytes).toBe(100);
  });

  it('counts unknown event types toward lastActiveAt but not aggregates', () => {
    const events = [ev('mystery_event', 7000), ev(EVENT_TYPES.sessionStart, 6000)];
    const s = aggregateUsage(record, events);
    expect(s.lastActiveAt).toBe(7000);
    expect(s.sessions).toBe(1);
    expect(s.jobs).toBe(0);
  });

  it('carries the revoked timestamp through to the summary', () => {
    const s = aggregateUsage({ ...record, revokedAt: 9999 }, []);
    expect(s.revokedAt).toBe(9999);
  });
});

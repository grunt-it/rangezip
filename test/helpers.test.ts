/**
 * Pure helper tests: request-body validation, R2 key joining, and entry
 * selection. No runtime needed.
 */

import { describe, expect, it } from 'vitest';
import { parseExtractBody } from '../src/app';
import { joinKey } from '../src/extract';
import { jobPrefix, selectEntries } from '../src/job';
import type { ByoConfig } from '../src/destination';
import type { ZipEntry } from '../src/zip';
import { CompressionMethod } from '../src/zip';

function entry(name: string): ZipEntry {
  return {
    name,
    compressionMethod: CompressionMethod.STORED,
    compressedSize: 1,
    uncompressedSize: 1,
    localHeaderOffset: 0,
    crc32: 1,
  };
}

describe('parseExtractBody', () => {
  it('accepts a valid body with no files (extract-all)', () => {
    const result = parseExtractBody({ sourceUrl: 'https://example.com/a.zip' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.files).toBeUndefined();
  });

  it('accepts a valid body with a files array', () => {
    const result = parseExtractBody({
      sourceUrl: 'https://example.com/a.zip',
      files: ['a.txt', 'b.txt'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.files).toEqual(['a.txt', 'b.txt']);
  });

  it('ignores a client-supplied prefix (the server derives it from the jobId)', () => {
    // Back-compat / hardening: even if an old client sends `prefix`, it must be
    // ignored — the output namespace is server-derived, never client-controlled.
    const result = parseExtractBody({
      sourceUrl: 'https://example.com/a.zip',
      prefix: 'attacker-controlled',
    } as never);
    expect(result.ok).toBe(true);
    if (result.ok) expect('prefix' in result.value).toBe(false);
  });

  it.each([
    { case: 'missing sourceUrl', body: {} },
    { case: 'non-http url', body: { sourceUrl: 'ftp://example.com/a.zip' } },
    {
      case: 'non-string files',
      body: { sourceUrl: 'https://example.com/a.zip', files: [1, 2] },
    },
    {
      case: 'files not an array',
      body: { sourceUrl: 'https://example.com/a.zip', files: 'a.txt' },
    },
  ])('rejects invalid body: $case', ({ body }) => {
    expect(parseExtractBody(body as never).ok).toBe(false);
  });

  it('rejects a null body', () => {
    expect(parseExtractBody(null).ok).toBe(false);
  });

  it('defaults destination to demo when omitted', () => {
    const result = parseExtractBody({ sourceUrl: 'https://x/a.zip' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.destination).toBe('demo');
      expect(result.value.byo).toBeUndefined();
    }
  });

  it('accepts a byo destination with a complete config', () => {
    const result = parseExtractBody({
      sourceUrl: 'https://x/a.zip',
      destination: 'byo',
      byo: {
        endpoint: 'https://acct.r2.cloudflarestorage.com',
        region: 'auto',
        bucket: 'b',
        accessKeyId: 'k',
        secretAccessKey: 's',
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.destination).toBe('byo');
      expect(result.value.byo?.bucket).toBe('b');
    }
  });

  it('rejects a byo destination with a missing config', () => {
    const result = parseExtractBody({
      sourceUrl: 'https://x/a.zip',
      destination: 'byo',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown destination value', () => {
    const result = parseExtractBody({
      sourceUrl: 'https://x/a.zip',
      destination: 'gcs' as never,
    });
    expect(result.ok).toBe(false);
  });
});

describe('jobPrefix — multi-user isolation', () => {
  const byo = (prefix?: string): ByoConfig => ({
    endpoint: 'https://acct.r2.cloudflarestorage.com',
    region: 'auto',
    bucket: 'b',
    accessKeyId: 'k',
    secretAccessKey: 's',
    prefix,
  });

  it('demo: the prefix IS the jobId', () => {
    expect(jobPrefix('job-aaaa')).toBe('job-aaaa');
  });

  it('BYO: folds the jobId UNDER the user in-bucket prefix', () => {
    expect(jobPrefix('job-aaaa', byo('exports'))).toBe('exports/job-aaaa');
  });

  it('BYO without an in-bucket prefix falls back to just the jobId', () => {
    expect(jobPrefix('job-aaaa', byo(undefined))).toBe('job-aaaa');
    expect(jobPrefix('job-aaaa', byo(''))).toBe('job-aaaa');
  });

  it('two different jobs NEVER share a key prefix (collision-safe)', () => {
    // The core correctness guarantee: distinct jobIds ⇒ distinct namespaces, so
    // job A's output can't overwrite job B's, nor can A's cleanup wipe B's.
    const a = jobPrefix('job-aaaa');
    const b = jobPrefix('job-bbbb');
    expect(a).not.toBe(b);
    // And neither is a prefix of the other (no `<a>/…` overlapping `<b>/…`).
    expect(joinKey(a, 'f.txt').startsWith(joinKey(b, ''))).toBe(false);
    expect(joinKey(b, 'f.txt').startsWith(joinKey(a, ''))).toBe(false);
  });

  it('two BYO jobs under the SAME in-bucket prefix still never collide', () => {
    const a = jobPrefix('job-aaaa', byo('shared/exports'));
    const b = jobPrefix('job-bbbb', byo('shared/exports'));
    expect(a).toBe('shared/exports/job-aaaa');
    expect(b).toBe('shared/exports/job-bbbb');
    expect(a).not.toBe(b);
  });
});

describe('joinKey', () => {
  it('joins prefix and name with a single slash', () => {
    expect(joinKey('out', 'a.txt')).toBe('out/a.txt');
  });
  it('does not double slashes', () => {
    expect(joinKey('out/', '/a.txt')).toBe('out/a.txt');
  });
  it('preserves nested entry paths', () => {
    expect(joinKey('out', 'dir/a.txt')).toBe('out/dir/a.txt');
  });
  it('handles an empty prefix', () => {
    expect(joinKey('', 'a.txt')).toBe('a.txt');
  });
});

describe('selectEntries', () => {
  const entries = [entry('a.txt'), entry('dir/'), entry('b.txt'), entry('c.txt')];

  it('returns all non-directory entries when files is undefined', () => {
    expect(selectEntries(entries).map((e) => e.name)).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('returns the requested subset in request order', () => {
    expect(selectEntries(entries, ['c.txt', 'a.txt']).map((e) => e.name)).toEqual([
      'c.txt',
      'a.txt',
    ]);
  });

  it('silently skips names not present (validation lives in the API layer)', () => {
    expect(selectEntries(entries, ['a.txt', 'nope.txt']).map((e) => e.name)).toEqual(['a.txt']);
  });

  it('never selects a directory entry', () => {
    expect(selectEntries(entries, ['dir/']).map((e) => e.name)).toEqual([]);
  });
});

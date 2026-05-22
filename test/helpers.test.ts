/**
 * Pure helper tests: request-body validation, R2 key joining, and entry
 * selection. No runtime needed.
 */

import { describe, expect, it } from 'vitest';
import { parseExtractBody } from '../src/app';
import { joinKey } from '../src/extract';
import { selectEntries } from '../src/job';
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
    const result = parseExtractBody({ sourceUrl: 'https://example.com/a.zip', prefix: 'out' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.files).toBeUndefined();
  });

  it('accepts a valid body with a files array', () => {
    const result = parseExtractBody({
      sourceUrl: 'https://example.com/a.zip',
      prefix: 'out',
      files: ['a.txt', 'b.txt'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.files).toEqual(['a.txt', 'b.txt']);
  });

  it.each([
    { case: 'missing sourceUrl', body: { prefix: 'out' } },
    { case: 'non-http url', body: { sourceUrl: 'ftp://example.com/a.zip', prefix: 'out' } },
    { case: 'missing prefix', body: { sourceUrl: 'https://example.com/a.zip' } },
    { case: 'empty prefix', body: { sourceUrl: 'https://example.com/a.zip', prefix: '' } },
    {
      case: 'non-string files',
      body: { sourceUrl: 'https://example.com/a.zip', prefix: 'out', files: [1, 2] },
    },
    {
      case: 'files not an array',
      body: { sourceUrl: 'https://example.com/a.zip', prefix: 'out', files: 'a.txt' },
    },
  ])('rejects invalid body: $case', ({ body }) => {
    expect(parseExtractBody(body as never).ok).toBe(false);
  });

  it('rejects a null body', () => {
    expect(parseExtractBody(null).ok).toBe(false);
  });

  it('defaults destination to demo when omitted', () => {
    const result = parseExtractBody({ sourceUrl: 'https://x/a.zip', prefix: 'out' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.destination).toBe('demo');
      expect(result.value.byo).toBeUndefined();
    }
  });

  it('accepts a byo destination with a complete config', () => {
    const result = parseExtractBody({
      sourceUrl: 'https://x/a.zip',
      prefix: 'out',
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
      prefix: 'out',
      destination: 'byo',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown destination value', () => {
    const result = parseExtractBody({
      sourceUrl: 'https://x/a.zip',
      prefix: 'out',
      destination: 'gcs' as never,
    });
    expect(result.ok).toBe(false);
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

/**
 * Pure destination-helper tests: BYO config validation, object-URL building
 * (the SigV4 PUT target), and prefix composition. No network — these are the
 * pure pieces that decide WHERE a BYO write lands and whether a config is even
 * shaped right before we attempt to sign anything.
 */

import { describe, expect, it } from 'vitest';
import { buildObjectUrl, composePrefix, parseByoConfig } from '../src/destination';

const valid = {
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'exports',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'shhh',
};

describe('parseByoConfig', () => {
  it('accepts a complete config and strips a trailing slash from endpoint', () => {
    const r = parseByoConfig({ ...valid, endpoint: 'https://acct.r2.cloudflarestorage.com/' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.endpoint).toBe('https://acct.r2.cloudflarestorage.com');
  });

  it('accepts an optional prefix', () => {
    const r = parseByoConfig({ ...valid, prefix: 'team/exports' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.prefix).toBe('team/exports');
  });

  it.each(['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey'])(
    'rejects when %s is missing',
    (field) => {
      const broken: Record<string, unknown> = { ...valid };
      delete broken[field];
      expect(parseByoConfig(broken).ok).toBe(false);
    },
  );

  it('rejects an empty-string required field', () => {
    expect(parseByoConfig({ ...valid, bucket: '' }).ok).toBe(false);
  });

  it('rejects a non-http endpoint', () => {
    expect(parseByoConfig({ ...valid, endpoint: 'ftp://acct/' }).ok).toBe(false);
    expect(parseByoConfig({ ...valid, endpoint: 'not a url' }).ok).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(parseByoConfig(null).ok).toBe(false);
    expect(parseByoConfig('string').ok).toBe(false);
  });

  it('rejects a non-string prefix', () => {
    expect(parseByoConfig({ ...valid, prefix: 42 }).ok).toBe(false);
  });
});

describe('buildObjectUrl', () => {
  it('joins endpoint, bucket, and key path-style', () => {
    expect(buildObjectUrl('https://e.com', 'b', 'dir/file.txt')).toBe(
      'https://e.com/b/dir/file.txt',
    );
  });
  it('collapses redundant slashes', () => {
    expect(buildObjectUrl('https://e.com/', 'b', '/dir/file.txt')).toBe(
      'https://e.com/b/dir/file.txt',
    );
  });
  it('percent-encodes key segments but preserves path separators', () => {
    expect(buildObjectUrl('https://e.com', 'b', 'a dir/my file.txt')).toBe(
      'https://e.com/b/a%20dir/my%20file.txt',
    );
  });
  it('encodes unicode in names', () => {
    expect(buildObjectUrl('https://e.com', 'b', 'café/résumé.pdf')).toBe(
      'https://e.com/b/caf%C3%A9/r%C3%A9sum%C3%A9.pdf',
    );
  });
});

describe('composePrefix', () => {
  it('joins bucket prefix and job prefix', () => {
    expect(composePrefix('team', 'job-1')).toBe('team/job-1');
  });
  it('drops empty segments and collapses slashes', () => {
    expect(composePrefix(undefined, 'job-1')).toBe('job-1');
    expect(composePrefix('/team/', '/job-1/')).toBe('team/job-1');
    expect(composePrefix('', '')).toBe('');
  });
});

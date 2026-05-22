/**
 * Build a real, on-disk-format ZIP buffer in-memory using `fflate`, so the
 * parser is tested against genuine ZIP bytes — not a hand-rolled mock that
 * could encode the author's misunderstanding of the format.
 *
 * `level: 0` forces a STORED entry; any positive level forces DEFLATE. We
 * include both so the extractor's method dispatch is exercised end to end.
 */

import { zipSync } from 'fflate';

export interface FixtureEntry {
  readonly name: string;
  readonly contents: Uint8Array;
  readonly stored: boolean;
}

export interface ZipFixture {
  readonly bytes: Uint8Array;
  readonly entries: readonly FixtureEntry[];
}

const encoder = new TextEncoder();

/** A small archive with one DEFLATE entry, one STORED entry, and a nested path. */
export function makeZipFixture(): ZipFixture {
  // Highly compressible text → DEFLATE actually shrinks it (compressed size <
  // uncompressed), which makes the size-field assertions meaningful.
  const deflatable = encoder.encode('rangezip '.repeat(512));
  // Tiny payload stored verbatim.
  const stored = encoder.encode('stored bytes — no compression here');
  // Nested path to exercise key joining and directory-ish names.
  const nested = encoder.encode('{"nested":true}');

  const entries: FixtureEntry[] = [
    { name: 'hello.txt', contents: deflatable, stored: false },
    { name: 'raw.bin', contents: stored, stored: true },
    { name: 'dir/data.json', contents: nested, stored: false },
  ];

  const bytes = zipSync(
    {
      'hello.txt': [deflatable, { level: 6 }],
      'raw.bin': [stored, { level: 0 }],
      'dir/data.json': [nested, { level: 6 }],
    },
    { level: 6 },
  );

  return { bytes, entries };
}

/**
 * A ZIP with one LARGE STORED entry, for exercising the parallel multipart path.
 *
 * The payload is `sizeBytes` of deterministic pseudo-random bytes (so it's
 * genuinely STORED — `level: 0` — and the round-trip byte-equality check is
 * meaningful). The default 6 MiB, paired with a 5 MiB part size and a lowered
 * threshold in the test, yields a 2-part plan (5 MiB + 1 MiB) — a real non-last
 * part at R2's 5 MiB floor plus a smaller final part. Kept this size on purpose:
 * the workerd test isolate has a tight heap, so the fixture stays just big enough
 * to cross the 5 MiB part floor without OOM-ing the pool.
 */
export function makeLargeStoredZipFixture(sizeBytes = 6 * 1024 * 1024): ZipFixture {
  const big = pseudoRandomBytes(sizeBytes);
  const small = encoder.encode('a small stored sibling');
  const entries: FixtureEntry[] = [
    { name: 'big.bin', contents: big, stored: true },
    { name: 'small.txt', contents: small, stored: true },
  ];
  const bytes = zipSync(
    {
      'big.bin': [big, { level: 0 }],
      'small.txt': [small, { level: 0 }],
    },
    { level: 0 },
  );
  return { bytes, entries };
}

/**
 * Deterministic pseudo-random byte fill (xorshift). Deterministic so a failing
 * round-trip is reproducible; non-constant so STORED stays STORED and a part
 * boundary bug shows up as a content mismatch rather than passing by accident.
 */
function pseudoRandomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let state = 0x9e3779b9 ^ n;
  for (let i = 0; i < n; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = state & 0xff;
  }
  return out;
}

/** Look up a fixture entry by name (test convenience). */
export function fixtureEntry(fixture: ZipFixture, name: string): FixtureEntry {
  const entry = fixture.entries.find((e) => e.name === name);
  if (!entry) throw new Error(`fixture has no entry "${name}"`);
  return entry;
}

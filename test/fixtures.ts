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

/** Look up a fixture entry by name (test convenience). */
export function fixtureEntry(fixture: ZipFixture, name: string): FixtureEntry {
  const entry = fixture.entries.find((e) => e.name === name);
  if (!entry) throw new Error(`fixture has no entry "${name}"`);
  return entry;
}

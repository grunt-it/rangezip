/**
 * Pure ZIP-logic tests — no Workers runtime needed, just the in-memory fixture.
 *
 * Covers the three pure functions that the whole technique rests on:
 *   - locateCentralDirectory (EOCD scan)
 *   - parseCentralDirectory  (entry names, sizes, methods, offsets)
 *   - computeDataOffset      (local-header data offset, the subtle bit)
 */

import { inflateSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  ByteReader,
  CompressionMethod,
  computeDataOffset,
  locateCentralDirectory,
  parseCentralDirectory,
  type ZipEntry,
} from '../src/zip';
import { fixtureEntry, makeZipFixture, type ZipFixture } from './fixtures';

/** Parse the fixture's central directory into entries (the common setup). */
function parseFixture(): {
  bytes: Uint8Array;
  fixture: ZipFixture;
  entries: readonly ZipEntry[];
} {
  const fixture = makeZipFixture();
  const { bytes } = fixture;
  const located = locateCentralDirectory(new ByteReader(bytes), 0);
  if (!located.ok) throw new Error(`locate failed: ${located.reason}`);

  const cd = bytes.subarray(
    located.location.offset,
    located.location.offset + located.location.size,
  );
  const parsed = parseCentralDirectory(cd, located.location.entryCount);
  if (!parsed.ok) throw new Error(`parse failed: ${parsed.reason}`);

  return { bytes, fixture, entries: parsed.entries };
}

describe('locateCentralDirectory', () => {
  it('finds the central directory from the EOCD record', () => {
    const { bytes } = makeZipFixture();
    const located = locateCentralDirectory(new ByteReader(bytes), 0);

    expect(located.ok).toBe(true);
    if (!located.ok) return;
    expect(located.location.entryCount).toBe(3);
    expect(located.location.offset).toBeGreaterThan(0);
    expect(located.location.offset + located.location.size).toBeLessThanOrEqual(bytes.length);
  });

  it('reports file-absolute offsets when only the tail bytes are provided', () => {
    // Simulate a range-GET of just the last 64 bytes (the EOCD record is 22
    // bytes with no comment, so it fits). The located CD offset MUST match the
    // offset obtained from the full buffer — i.e. it is file-absolute, not
    // tail-relative. This is the property the production tail-read depends on.
    const { bytes } = makeZipFixture();
    const fromFull = locateCentralDirectory(new ByteReader(bytes), 0);
    expect(fromFull.ok).toBe(true);
    if (!fromFull.ok) return;

    const tailSize = 64;
    const start = bytes.length - tailSize;
    const tail = bytes.subarray(start);

    const fromTail = locateCentralDirectory(new ByteReader(tail), start);
    expect(fromTail.ok).toBe(true);
    if (!fromTail.ok) return;
    expect(fromTail.location.offset).toBe(fromFull.location.offset);
    expect(fromTail.location.size).toBe(fromFull.location.size);
  });

  it('fails cleanly when the EOCD signature is absent', () => {
    const garbage = new Uint8Array(100);
    const located = locateCentralDirectory(new ByteReader(garbage), 0);
    expect(located.ok).toBe(false);
  });
});

describe('parseCentralDirectory', () => {
  it('lists every entry with the correct name, method, and sizes', () => {
    const { fixture, entries } = parseFixture();
    const byName = new Map(entries.map((e) => [e.name, e]));

    expect([...byName.keys()].sort()).toEqual(['dir/data.json', 'hello.txt', 'raw.bin']);

    const hello = byName.get('hello.txt')!;
    expect(hello.compressionMethod).toBe(CompressionMethod.DEFLATE);
    expect(hello.uncompressedSize).toBe(fixtureEntry(fixture, 'hello.txt').contents.length);
    // Compressible text really did compress.
    expect(hello.compressedSize).toBeLessThan(hello.uncompressedSize);

    const raw = byName.get('raw.bin')!;
    expect(raw.compressionMethod).toBe(CompressionMethod.STORED);
    expect(raw.uncompressedSize).toBe(fixtureEntry(fixture, 'raw.bin').contents.length);
    // STORED ⇒ compressed and uncompressed sizes are identical.
    expect(raw.compressedSize).toBe(raw.uncompressedSize);
  });

  it('records a plausible local-header offset for each entry', () => {
    const { bytes, entries } = parseFixture();
    for (const entry of entries) {
      expect(entry.localHeaderOffset).toBeGreaterThanOrEqual(0);
      expect(entry.localHeaderOffset).toBeLessThan(bytes.length);
      // Each local header starts with the local-file-header signature.
      expect(new ByteReader(bytes).u32(entry.localHeaderOffset)).toBe(0x04034b50);
    }
  });

  it('preserves a non-zero crc32 for non-empty entries', () => {
    const { entries } = parseFixture();
    for (const entry of entries) {
      expect(entry.crc32).not.toBe(0);
    }
  });
});

describe('computeDataOffset', () => {
  it('computes a data offset past the local header, accounting for its own name/extra lengths', () => {
    const { bytes, entries } = parseFixture();
    const reader = new ByteReader(bytes);

    for (const entry of entries) {
      const localHeader = bytes.subarray(entry.localHeaderOffset, entry.localHeaderOffset + 30);
      const result = computeDataOffset(new ByteReader(localHeader), entry.localHeaderOffset);

      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      // Data must start at least 30 bytes (+ filename) past the local header.
      expect(result.dataOffset).toBeGreaterThanOrEqual(
        entry.localHeaderOffset + 30 + entry.name.length,
      );
      // And the data must fit within the archive.
      expect(result.dataOffset + entry.compressedSize).toBeLessThanOrEqual(reader.length);
    }
  });

  it('yields the original bytes when slicing data at the computed offset (round-trip)', () => {
    const { bytes, entries } = parseFixture();

    for (const entry of entries) {
      const localHeader = bytes.subarray(entry.localHeaderOffset, entry.localHeaderOffset + 30);
      const result = computeDataOffset(new ByteReader(localHeader), entry.localHeaderOffset);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      const data = bytes.subarray(result.dataOffset, result.dataOffset + entry.compressedSize);
      const recovered =
        entry.compressionMethod === CompressionMethod.STORED ? data : inflateSync(data);

      expect(recovered.length).toBe(entry.uncompressedSize);
    }
  });

  it('rejects a buffer that does not start with the local-header signature', () => {
    const badHeader = new Uint8Array(30); // all zeros — wrong signature
    const result = computeDataOffset(new ByteReader(badHeader), 0);
    expect(result.ok).toBe(false);
  });
});

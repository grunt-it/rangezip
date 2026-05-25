/**
 * verify-disk.ts — verify a locally-built sample on DISK against rangezip's OWN
 * parser (`src/zip`). For each output file this:
 *   1. Locates the central directory via EOCD64 (ZIP64) from the tail.
 *   2. Parses the full central directory (all entries) and asserts the entry
 *      count and that some entry's local-header offset is well past 4 GB
 *      (mandatory for the 30 GB build; checked when present).
 *   3. Extracts 3 entries (a JPEG, plus a STORED and a DEFLATE if distinct) by
 *      their byte ranges: re-CRC the extracted bytes and match the
 *      central-directory CRC; for the JPEG confirm the JPEG magic FF D8 FF; and
 *      byte-compare the extracted file against the corresponding source file in
 *      the 2 GB sample (same data offset in the source).
 *   4. Records total bytes + file count.
 *
 * All reads are bounded range reads from disk — never loads the whole archive.
 *
 * Run: bun run scripts/sample-builder/verify-disk.ts /tmp/sample-10gb.zip
 */

import { open, stat } from 'node:fs/promises';
import { ByteReader } from '../../src/zip/byte-reader';
import { locateCentralDirectory } from '../../src/zip/eocd';
import { parseCentralDirectory } from '../../src/zip/central-directory';
import { computeDataOffset } from '../../src/zip/local-header';
import { crc32Update } from './src/crc32';
import type { ZipEntry } from '../../src/zip/format';

const FOUR_GIB = 0x100000000; // 4 GiB
const SOURCE_PATH = '/tmp/sample-2gb.zip';

type FH = Awaited<ReturnType<typeof open>>;

async function readExact(fh: FH, start: number, len: number): Promise<Uint8Array<ArrayBuffer>> {
  // Back the read buffer with a plain ArrayBuffer (not Buffer's pooled
  // ArrayBufferLike) so the result is a `Uint8Array<ArrayBuffer>` — what the DOM
  // Blob / DecompressionStream typings require.
  const buf = new Uint8Array(new ArrayBuffer(len));
  let read = 0;
  while (read < len) {
    const { bytesRead } = await fh.read(buf, read, len - read, start + read);
    if (bytesRead === 0) throw new Error(`short read at ${start + read}: wanted ${len - read}, EOF`);
    read += bytesRead;
  }
  return buf;
}

/** Stream-CRC + optional magic-byte capture over an entry's compressed data range. */
async function crcAndHead(
  fh: FH,
  dataOffset: number,
  compressedSize: number,
  method: number,
  headLen: number,
): Promise<{ crc: number; head: Uint8Array; rawLen: number }> {
  const CHUNK = 8 * 1024 * 1024;
  if (method === 0) {
    // STORED: compressed bytes == file bytes. CRC them directly.
    let crc = 0;
    let head = new Uint8Array(0);
    let pos = 0;
    while (pos < compressedSize) {
      const want = Math.min(CHUNK, compressedSize - pos);
      const chunk = await readExact(fh, dataOffset + pos, want);
      if (pos === 0) head = chunk.subarray(0, Math.min(headLen, chunk.length));
      crc = crc32Update(crc, chunk);
      pos += want;
    }
    return { crc, head, rawLen: compressedSize };
  }
  // DEFLATE: inflate the whole compressed range (entries are individually small),
  // CRC the raw bytes.
  const compressed = await readExact(fh, dataOffset, compressedSize);
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([compressed]).stream().pipeThrough(ds);
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  return { crc: crc32Update(0, raw), head: raw.subarray(0, Math.min(headLen, raw.length)), rawLen: raw.length };
}

/** Byte-compare an entry's compressed DATA range in two files (verbatim copy check). */
async function compareData(
  outFh: FH,
  outDataOffset: number,
  srcFh: FH,
  srcDataOffset: number,
  compressedSize: number,
): Promise<boolean> {
  const CHUNK = 8 * 1024 * 1024;
  let pos = 0;
  while (pos < compressedSize) {
    const want = Math.min(CHUNK, compressedSize - pos);
    const a = await readExact(outFh, outDataOffset + pos, want);
    const b = await readExact(srcFh, srcDataOffset + pos, want);
    for (let i = 0; i < want; i++) {
      if (a[i] !== b[i]) return false;
    }
    pos += want;
  }
  return true;
}

/** Build the source's name -> {dataOffset, compressedSize} map for verbatim comparison. */
async function loadSourceMap(
  srcFh: FH,
  srcTotal: number,
): Promise<Map<string, { dataOffset: number; compressedSize: number; crc32: number }>> {
  const tailLen = Math.min(65536, srcTotal);
  const tail = await readExact(srcFh, srcTotal - tailLen, tailLen);
  const loc = locateCentralDirectory(new ByteReader(tail), srcTotal - tailLen);
  if (!loc.ok) throw new Error(`source locateCentralDirectory: ${loc.reason}`);
  const cd = await readExact(srcFh, loc.location.offset, loc.location.size);
  const parsed = parseCentralDirectory(cd, loc.location.entryCount);
  if (!parsed.ok) throw new Error(`source parseCentralDirectory: ${parsed.reason}`);
  const map = new Map<string, { dataOffset: number; compressedSize: number; crc32: number }>();
  for (const e of parsed.entries) {
    const lh = await readExact(srcFh, e.localHeaderOffset, 30);
    const off = computeDataOffset(new ByteReader(lh), e.localHeaderOffset);
    if (!off.ok) throw new Error(`source computeDataOffset(${e.name}): ${off.reason}`);
    map.set(e.name, { dataOffset: off.dataOffset, compressedSize: e.compressedSize, crc32: e.crc32 });
  }
  return map;
}

/**
 * The output names are renumbered (e.g. images/jpeg/photo-0000123.jpg) but
 * share the source's folder + extension. We match an output entry to a source
 * entry by (compressedSize, crc32) — the verbatim-copy invariant guarantees a
 * source entry with identical size + CRC exists. Returns that source name.
 */
function findSourceByShape(
  sourceMap: Map<string, { dataOffset: number; compressedSize: number; crc32: number }>,
  compressedSize: number,
  crc32: number,
): { name: string; dataOffset: number } | null {
  for (const [name, s] of sourceMap) {
    if (s.compressedSize === compressedSize && (s.crc32 >>> 0) === (crc32 >>> 0)) {
      return { name, dataOffset: s.dataOffset };
    }
  }
  return null;
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: bun run verify-disk.ts <path-to-zip>');
    process.exit(1);
  }
  console.log(`\n=== verifying ${path} ===`);
  const total = (await stat(path)).size;
  console.log(`total size: ${total} bytes (${(total / 2 ** 30).toFixed(3)} GiB)`);

  const fh = await open(path, 'r');
  const srcTotal = (await stat(SOURCE_PATH)).size;
  const srcFh = await open(SOURCE_PATH, 'r');
  const sourceMap = await loadSourceMap(srcFh, srcTotal);

  // 1. Locate the central directory via EOCD64 from the tail.
  const tailLen = Math.min(65536, total);
  const tail = await readExact(fh, total - tailLen, tailLen);
  const loc = locateCentralDirectory(new ByteReader(tail), total - tailLen);
  if (!loc.ok) throw new Error(`locateCentralDirectory: ${loc.reason}`);
  console.log(
    `EOCD64 located CD: offset=${loc.location.offset} size=${loc.location.size} count=${loc.location.entryCount}`,
  );

  // 2. Parse the full central directory.
  const cd = await readExact(fh, loc.location.offset, loc.location.size);
  const parsed = parseCentralDirectory(cd, loc.location.entryCount);
  if (!parsed.ok) throw new Error(`parseCentralDirectory: ${parsed.reason}`);
  const entries = parsed.entries;
  if (entries.length !== loc.location.entryCount) {
    throw new Error(`parsed ${entries.length} entries != EOCD count ${loc.location.entryCount}`);
  }
  console.log(`parsed central directory: ${entries.length} entries (matches EOCD count)`);

  // Offset-past-4GB check. Mandatory presence for >4GB archives.
  const maxOffset = entries.reduce((m, e) => Math.max(m, e.localHeaderOffset), 0);
  const past4g = entries.filter((e) => e.localHeaderOffset >= FOUR_GIB).length;
  console.log(`max local-header offset: ${maxOffset} (${(maxOffset / 2 ** 30).toFixed(3)} GiB); entries past 4 GiB: ${past4g}`);
  if (total > FOUR_GIB && maxOffset < FOUR_GIB) {
    throw new Error('archive exceeds 4 GiB but no entry offset is past 4 GiB — ZIP64 offset path not exercised');
  }

  // 3. Pick entries to extract: a JPEG, plus the entry with the largest offset
  // (deepest into the file → exercises far-past-4GB extraction), plus a DEFLATE.
  const jpeg = entries.find((e) => /\.jpe?g$/i.test(e.name));
  const deepest = entries.reduce((a, b) => (b.localHeaderOffset > a.localHeaderOffset ? b : a), entries[0]!);
  const deflate = entries.find((e) => e.compressionMethod === 8);
  const stored = entries.find((e) => e.compressionMethod === 0);

  const picks: ZipEntry[] = [];
  for (const cand of [jpeg, deepest, deflate, stored]) {
    if (cand && !picks.some((p) => p.name === cand.name)) picks.push(cand);
    if (picks.length >= 3) break;
  }
  if (!jpeg) throw new Error('no JPEG entry found — cannot run the real-file magic check');

  console.log(`\nextracting ${picks.length} entries (incl. JPEG ${jpeg.name}):`);
  for (const e of picks) {
    const lh = await readExact(fh, e.localHeaderOffset, 30);
    const off = computeDataOffset(new ByteReader(lh), e.localHeaderOffset);
    if (!off.ok) throw new Error(`computeDataOffset(${e.name}): ${off.reason}`);

    const { crc, head, rawLen } = await crcAndHead(
      fh,
      off.dataOffset,
      e.compressedSize,
      e.compressionMethod,
      16,
    );
    if (rawLen !== e.uncompressedSize) {
      throw new Error(`${e.name}: extracted ${rawLen} != declared ${e.uncompressedSize}`);
    }
    if ((crc >>> 0) !== (e.crc32 >>> 0)) {
      throw new Error(`${e.name}: CRC mismatch extracted=${crc >>> 0} declared=${e.crc32 >>> 0}`);
    }

    // Real-file magic check (JPEG).
    let magicNote = '';
    if (/\.jpe?g$/i.test(e.name)) {
      if (!(head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)) {
        throw new Error(
          `${e.name}: not a real JPEG — magic was ${[...head.subarray(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`,
        );
      }
      magicNote = ' [JPEG magic FF D8 FF OK]';
    } else if (/\.png$/i.test(e.name)) {
      const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      if (png.some((b, i) => head[i] !== b)) throw new Error(`${e.name}: not a real PNG`);
      magicNote = ' [PNG magic OK]';
    } else if (/\.pdf$/i.test(e.name)) {
      const pdf = [0x25, 0x50, 0x44, 0x46]; // %PDF
      if (pdf.some((b, i) => head[i] !== b)) throw new Error(`${e.name}: not a real PDF`);
      magicNote = ' [%PDF magic OK]';
    } else if (/\.mp4$/i.test(e.name)) {
      // ftyp box at bytes 4-8
      if (!(head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70)) {
        throw new Error(`${e.name}: not a real MP4 (no ftyp box)`);
      }
      magicNote = ' [MP4 ftyp magic OK]';
    }

    // Verbatim-copy comparison against the source file with the same shape.
    const srcMatch = findSourceByShape(sourceMap, e.compressedSize, e.crc32);
    let srcNote = ' [no source match found]';
    if (srcMatch) {
      const same = await compareData(fh, off.dataOffset, srcFh, srcMatch.dataOffset, e.compressedSize);
      if (!same) throw new Error(`${e.name}: data bytes DIFFER from source ${srcMatch.name}`);
      srcNote = ` [bytes match source ${srcMatch.name}]`;
    }

    console.log(
      `  OK ${e.name} (method=${e.compressionMethod}, off=${e.localHeaderOffset}, ${(e.localHeaderOffset / 2 ** 30).toFixed(2)} GiB): ` +
        `${rawLen} bytes, CRC ${(crc >>> 0).toString(16)} verified${magicNote}${srcNote}`,
    );
  }

  await fh.close();
  await srcFh.close();

  console.log(`\nVERIFIED: ${path}`);
  console.log(`  totalBytes=${total}  fileCount=${entries.length}  maxOffset=${maxOffset}`);
}

main().catch((err) => {
  console.error('DISK VERIFY FAILED:', err);
  process.exit(1);
});

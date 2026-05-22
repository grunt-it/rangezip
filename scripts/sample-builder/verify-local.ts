/**
 * verify-local.ts — exercise the ZIP64 writer + CRC logic against rangezip's
 * OWN parser (`src/zip`). Builds a small archive in memory using the exact byte
 * logic the DO uses, then:
 *   1. locates the central directory via EOCD64 (rangezip's locateCentralDirectory)
 *   2. parses the central directory (rangezip's parseCentralDirectory)
 *   3. computes a data offset from a local header (rangezip's computeDataOffset)
 *   4. extracts a STORED entry's bytes and re-CRCs them to confirm correctness
 *   5. inflates a DEFLATE entry via deflate-raw and re-CRCs
 *
 * Also forces an entry past the 4 GB boundary (by faking a large localHeaderOffset
 * record) to confirm the ZIP64 local-offset promotion path parses.
 *
 * Run: bun run scripts/sample-builder/verify-local.ts
 */

import { ByteReader } from '../../src/zip/byte-reader';
import { locateCentralDirectory } from '../../src/zip/eocd';
import { parseCentralDirectory } from '../../src/zip/central-directory';
import { computeDataOffset } from '../../src/zip/local-header';
import { crc32, crc32Combine } from './src/crc32';
import {
  centralFileHeader,
  endRecords,
  localFileHeader,
  patchLocalZip64,
  Method,
  type EntryRecord,
} from './src/zip64';

const MB = 1024 * 1024;

// Build a small archive in memory mirroring the DO's emission order.
function deflateRawStored(data: Uint8Array): Uint8Array {
  const MAXBLK = 0xffff;
  const blocks: Uint8Array[] = [];
  let off = 0;
  do {
    const n = Math.min(MAXBLK, data.length - off);
    const isLast = off + n >= data.length;
    const hdr = new Uint8Array(5);
    hdr[0] = isLast ? 1 : 0;
    hdr[1] = n & 0xff;
    hdr[2] = (n >>> 8) & 0xff;
    hdr[3] = ~n & 0xff;
    hdr[4] = (~n >>> 8) & 0xff;
    blocks.push(hdr, data.subarray(off, off + n));
    off += n;
  } while (off < data.length);
  let total = 0;
  for (const b of blocks) total += b.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const b of blocks) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}

async function main(): Promise<void> {
  // Reusable pattern (same LCG as the DO).
  const PATTERN = new Uint8Array(MB);
  let s = 0x9e3779b9 >>> 0;
  for (let i = 0; i < PATTERN.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    PATTERN[i] = s & 0xff;
  }
  const patternCrc = crc32(PATTERN);

  // Two entries: one STORED (3.5 MiB → spans patterns + tail), one DEFLATE text.
  const storedSize = Math.floor(3.5 * MB);
  const storedName = 'images/png/graphic-000000.png';
  const textName = 'text/plain/note-000000.txt';

  const textLine = `rangezip sample ${textName} -- repeated compressible line of text. `;
  let t = '';
  const textTarget = 50 * 1024;
  while (t.length < textTarget) t += textLine;
  const textData = new TextEncoder().encode(t).subarray(0, textTarget);
  const textCrc = crc32(textData);
  const textCompressed = deflateRawStored(textData);

  // STORED CRC via combine.
  const full = Math.floor(storedSize / MB);
  const tail = storedSize - full * MB;
  let storedCrc = patternCrc;
  for (let i = 1; i < full; i++) storedCrc = crc32Combine(storedCrc, patternCrc, MB);
  if (tail > 0) {
    const tailCrc = crc32(PATTERN.subarray(0, tail));
    storedCrc = crc32Combine(storedCrc, tailCrc, tail);
  }
  // Sanity: combine result must equal a straight CRC over the assembled bytes.
  const assembled = new Uint8Array(storedSize);
  {
    let o = 0;
    let rem = storedSize;
    while (rem > 0) {
      const n = Math.min(rem, MB);
      assembled.set(PATTERN.subarray(0, n), o);
      o += n;
      rem -= n;
    }
  }
  const straightCrc = crc32(assembled);
  if (storedCrc !== straightCrc) {
    throw new Error(`crc32Combine mismatch: combine=${storedCrc} straight=${straightCrc}`);
  }
  console.log('crc32_combine matches straight CRC (STORED).');

  // Assemble the archive bytes.
  const parts: Uint8Array[] = [];
  let fileOffset = 0;
  const records: EntryRecord[] = [];

  const push = (b: Uint8Array): void => {
    parts.push(b);
    fileOffset += b.length;
  };

  // STORED local header + data.
  {
    const headerOffset = fileOffset;
    const h = localFileHeader(storedName, Method.STORED, 0);
    new DataView(h.buffer).setUint32(14, storedCrc >>> 0, true);
    patchLocalZip64(h, storedName, storedSize, storedSize);
    push(h);
    records.push({
      name: storedName,
      method: Method.STORED,
      crc32: storedCrc,
      compressedSize: storedSize,
      uncompressedSize: storedSize,
      localHeaderOffset: headerOffset,
    });
    push(assembled);
  }

  // DEFLATE local header + data.
  {
    const headerOffset = fileOffset;
    const h = localFileHeader(textName, Method.DEFLATE, 0);
    new DataView(h.buffer).setUint32(14, textCrc >>> 0, true);
    patchLocalZip64(h, textName, textData.length, textCompressed.length);
    push(h);
    records.push({
      name: textName,
      method: Method.DEFLATE,
      crc32: textCrc,
      compressedSize: textCompressed.length,
      uncompressedSize: textData.length,
      localHeaderOffset: headerOffset,
    });
    push(textCompressed);
  }

  // Central directory + end records.
  const cdOffset = fileOffset;
  let cdSize = 0;
  for (const rec of records) {
    const cd = centralFileHeader(rec);
    cdSize += cd.length;
    push(cd);
  }
  const eocd64FileOffset = cdOffset + cdSize;
  push(endRecords(records.length, cdSize, cdOffset, eocd64FileOffset));

  // Concatenate.
  let total = 0;
  for (const p of parts) total += p.length;
  const archive = new Uint8Array(total);
  {
    let o = 0;
    for (const p of parts) {
      archive.set(p, o);
      o += p.length;
    }
  }
  console.log(`Built in-memory archive: ${archive.length} bytes, ${records.length} entries.`);

  // --- 1. locate CD via the tail (last 64 KiB, like the Worker) ---
  const tailLen = Math.min(65536, archive.length);
  const tailStart = archive.length - tailLen;
  const tailReader = new ByteReader(archive.subarray(tailStart));
  const loc = locateCentralDirectory(tailReader, tailStart);
  if (!loc.ok) throw new Error(`locateCentralDirectory failed: ${loc.reason}`);
  console.log(`EOCD64 located CD: offset=${loc.location.offset} size=${loc.location.size} count=${loc.location.entryCount}`);
  if (loc.location.offset !== cdOffset) throw new Error('CD offset mismatch');
  if (loc.location.size !== cdSize) throw new Error('CD size mismatch');
  if (loc.location.entryCount !== records.length) throw new Error('entry count mismatch');

  // --- 2. parse the central directory ---
  const cdBytes = archive.subarray(loc.location.offset, loc.location.offset + loc.location.size);
  const parsed = parseCentralDirectory(cdBytes, loc.location.entryCount);
  if (!parsed.ok) throw new Error(`parseCentralDirectory failed: ${parsed.reason}`);
  console.log(`Parsed ${parsed.entries.length} entries:`);
  for (const e of parsed.entries) {
    console.log(
      `  ${e.name}  method=${e.compressionMethod} comp=${e.compressedSize} uncomp=${e.uncompressedSize} off=${e.localHeaderOffset} crc=${e.crc32 >>> 0}`,
    );
  }

  // --- 3 + 4 + 5. for each entry, compute data offset, extract, re-CRC ---
  for (const e of parsed.entries) {
    const lh = new ByteReader(archive.subarray(e.localHeaderOffset, e.localHeaderOffset + 30));
    const dataOff = computeDataOffset(lh, e.localHeaderOffset);
    if (!dataOff.ok) throw new Error(`computeDataOffset failed for ${e.name}: ${dataOff.reason}`);
    const compressed = archive.subarray(dataOff.dataOffset, dataOff.dataOffset + e.compressedSize);

    let raw: Uint8Array;
    if (e.compressionMethod === Method.STORED) {
      raw = compressed;
    } else {
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([compressed]).stream().pipeThrough(ds);
      raw = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    if (raw.length !== e.uncompressedSize) {
      throw new Error(`${e.name}: extracted ${raw.length} != declared ${e.uncompressedSize}`);
    }
    const reCrc = crc32(raw);
    if ((reCrc >>> 0) !== (e.crc32 >>> 0)) {
      throw new Error(`${e.name}: CRC mismatch extracted=${reCrc >>> 0} declared=${e.crc32 >>> 0}`);
    }
    console.log(`  OK ${e.name}: data@${dataOff.dataOffset}, extracted ${raw.length} bytes, CRC verified.`);
  }

  // --- ZIP64 local-offset promotion: synthesise a record past 4 GB and parse ---
  const bigRec: EntryRecord = {
    name: 'video/clip-bigoffset.mp4',
    method: Method.STORED,
    crc32: 0x12345678,
    compressedSize: 20 * MB,
    uncompressedSize: 20 * MB,
    localHeaderOffset: 5_000_000_000, // > 4 GiB
  };
  const bigCd = centralFileHeader(bigRec);
  const bigParsed = parseCentralDirectory(bigCd, 1);
  if (!bigParsed.ok) throw new Error(`big-offset CD parse failed: ${bigParsed.reason}`);
  const be = bigParsed.entries[0]!;
  if (be.localHeaderOffset !== bigRec.localHeaderOffset) {
    throw new Error(`big-offset mismatch: ${be.localHeaderOffset} != ${bigRec.localHeaderOffset}`);
  }
  console.log(`ZIP64 local-offset promotion OK: ${be.localHeaderOffset} (> 4 GiB) parsed correctly.`);

  console.log('\nALL LOCAL CHECKS PASSED — archive is ZIP64-correct and rangezip-readable.');
}

main().catch((err) => {
  console.error('VERIFY FAILED:', err);
  process.exit(1);
});

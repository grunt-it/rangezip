/**
 * verify-remote.ts — verify an uploaded sample against rangezip's OWN parser by
 * range-fetching only the small bits (tail + central directory + a couple of
 * local headers + one entry's data). Bandwidth-light: never downloads the whole
 * archive. Confirms 206 range support, EOCD64/central-directory parse, a STORED
 * extract (+CRC), and a DEFLATE extract (+CRC).
 *
 * Run: bun run scripts/sample-builder/verify-remote.ts <publicUrl>
 */

import { ByteReader } from '../../src/zip/byte-reader';
import { locateCentralDirectory } from '../../src/zip/eocd';
import { parseCentralDirectory } from '../../src/zip/central-directory';
import { computeDataOffset } from '../../src/zip/local-header';
import { crc32 } from './src/crc32';

const url = process.argv[2];
if (!url) {
  console.error('usage: bun run verify-remote.ts <publicUrl>');
  process.exit(1);
}

async function rangeGet(u: string, start: number, end: number): Promise<{ status: number; bytes: Uint8Array }> {
  const resp = await fetch(u, { headers: { Range: `bytes=${start}-${end}` } });
  const buf = new Uint8Array(await resp.arrayBuffer());
  return { status: resp.status, bytes: buf };
}

async function main(): Promise<void> {
  // Total size from a HEAD.
  const head = await fetch(url, { method: 'HEAD' });
  const totalSize = Number(head.headers.get('content-length'));
  console.log(`HEAD: ${head.status}, total size = ${totalSize} bytes (${(totalSize / 2 ** 30).toFixed(3)} GiB)`);
  if (!head.headers.get('accept-ranges')) console.warn('  (no Accept-Ranges header advertised)');

  // 1. tail: last 64 KiB. Confirm 206.
  const tailLen = Math.min(65536, totalSize);
  const tailStart = totalSize - tailLen;
  const tail = await rangeGet(url, tailStart, totalSize - 1);
  console.log(`Tail range request: HTTP ${tail.status} (${tail.bytes.length} bytes)`);
  if (tail.status !== 206) throw new Error(`expected 206 for range request, got ${tail.status}`);

  const loc = locateCentralDirectory(new ByteReader(tail.bytes), tailStart);
  if (!loc.ok) throw new Error(`locateCentralDirectory failed: ${loc.reason}`);
  console.log(`EOCD64 CD: offset=${loc.location.offset} size=${loc.location.size} count=${loc.location.entryCount}`);

  // 2. central directory.
  const cd = await rangeGet(url, loc.location.offset, loc.location.offset + loc.location.size - 1);
  if (cd.status !== 206) throw new Error(`CD range request not 206: ${cd.status}`);
  const parsed = parseCentralDirectory(cd.bytes, loc.location.entryCount);
  if (!parsed.ok) throw new Error(`parseCentralDirectory failed: ${parsed.reason}`);
  console.log(`Parsed central directory: ${parsed.entries.length} entries.`);

  // 3. pick one STORED and one DEFLATE entry, extract + CRC.
  const stored = parsed.entries.find((e) => e.compressionMethod === 0);
  const deflate = parsed.entries.find((e) => e.compressionMethod === 8);

  for (const e of [stored, deflate]) {
    if (!e) continue;
    const lhRange = await rangeGet(url, e.localHeaderOffset, e.localHeaderOffset + 29);
    const dataOff = computeDataOffset(new ByteReader(lhRange.bytes), e.localHeaderOffset);
    if (!dataOff.ok) throw new Error(`computeDataOffset failed for ${e.name}: ${dataOff.reason}`);
    const data = await rangeGet(url, dataOff.dataOffset, dataOff.dataOffset + e.compressedSize - 1);
    if (data.status !== 206) throw new Error(`data range not 206 for ${e.name}: ${data.status}`);

    let raw: Uint8Array;
    if (e.compressionMethod === 0) {
      raw = data.bytes;
    } else {
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([data.bytes]).stream().pipeThrough(ds);
      raw = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    if (raw.length !== e.uncompressedSize) {
      throw new Error(`${e.name}: extracted ${raw.length} != declared ${e.uncompressedSize}`);
    }
    const reCrc = crc32(raw) >>> 0;
    if (reCrc !== (e.crc32 >>> 0)) {
      throw new Error(`${e.name}: CRC mismatch extracted=${reCrc} declared=${e.crc32 >>> 0}`);
    }
    console.log(
      `  OK ${e.name} (method=${e.compressionMethod}): data@${dataOff.dataOffset}, ${raw.length} bytes extracted, CRC verified.`,
    );
  }

  // folder breakdown
  const byFolder: Record<string, number> = {};
  for (const e of parsed.entries) {
    const folder = e.name.split('/').slice(0, 2).join('/');
    byFolder[folder] = (byFolder[folder] ?? 0) + 1;
  }
  console.log('Folder breakdown:');
  for (const [k, v] of Object.entries(byFolder)) console.log(`  ${k.padEnd(18)} ${v}`);

  console.log(`\nVERIFIED: ${url}`);
  console.log(`  totalSize=${totalSize}  fileCount=${parsed.entries.length}`);
}

main().catch((err) => {
  console.error('REMOTE VERIFY FAILED:', err);
  process.exit(1);
});

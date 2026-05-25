/**
 * build-local.ts — LOCAL (on-disk) verbatim-copy ZIP64 sample builder.
 *
 * The server-side DO builder (`builder-do.ts`) wedged at ~99% on a DO
 * alarm-resume bug, so this is the local pivot: same verbatim-copy + ZIP64
 * writing LOGIC (reused from `plan.ts` / `zip64.ts` and rangezip's `src/zip`
 * parser), but pure local FILE I/O — read the 2 GB source zip from disk, write
 * the output zip to disk. NO R2, NO multipart, NO network.
 *
 * What it does:
 *   1. Parse the 2 GB sample's central directory (rangezip's
 *      locateCentralDirectory + parseCentralDirectory over a tail slice + the
 *      CD slice read from disk) → its 510 REAL entries, each with the byte
 *      offset where its DATA begins (rangezip's computeDataOffset over the
 *      30-byte local header read from disk).
 *   2. `buildPlan` cycles through those entries repeatedly until the target DATA
 *      size is reached, giving each output entry a fresh unique name (folder +
 *      extension preserved) but the SAME method / sizes / CRC.
 *   3. Stream-write the output: per entry a fresh ZIP64 local header followed by
 *      the entry's DATA copied VERBATIM (no decompress/recompress) from the
 *      source file at its data offset, in bounded chunks. Then the ZIP64 central
 *      directory + EOCD64 + locator + sentineled classic EOCD.
 *
 * Memory discipline: only small headers + one reusable copy buffer are ever
 * held; entry DATA streams source→output in COPY_CHUNK reads. Never buffers a
 * whole entry, let alone the archive.
 *
 * Run:
 *   bun run scripts/sample-builder/build-local.ts 10gb   # -> /tmp/sample-10gb.zip
 *   bun run scripts/sample-builder/build-local.ts 30gb   # -> /tmp/sample-30gb.zip
 *   bun run scripts/sample-builder/build-local.ts both    # both, sequentially
 */

import { open, stat } from 'node:fs/promises';
import { ByteReader } from '../../src/zip/byte-reader';
import { locateCentralDirectory } from '../../src/zip/eocd';
import { parseCentralDirectory } from '../../src/zip/central-directory';
import { computeDataOffset } from '../../src/zip/local-header';
import { buildPlan, type SourceEntry } from './src/plan';
import {
  centralFileHeader,
  endRecords,
  localFileHeader,
  patchLocalZip64,
  type EntryRecord,
} from './src/zip64';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const COPY_CHUNK = 8 * MB; // verbatim-copy read chunk
const TAIL_SCAN = 65536; // tail bytes to scan for the EOCD

const SOURCE_PATH = '/tmp/sample-2gb.zip';

const TARGETS: Record<string, { out: string; target: number }> = {
  '10gb': { out: '/tmp/sample-10gb.zip', target: 10 * GB },
  '30gb': { out: '/tmp/sample-30gb.zip', target: 30 * GB },
};

/** Read exactly [start, start+len) from an open file handle into a fresh Uint8Array. */
async function readExact(
  fh: Awaited<ReturnType<typeof open>>,
  start: number,
  len: number,
): Promise<Uint8Array> {
  const buf = Buffer.allocUnsafe(len);
  let read = 0;
  while (read < len) {
    const { bytesRead } = await fh.read(buf, read, len - read, start + read);
    if (bytesRead === 0) throw new Error(`short read at ${start + read}: wanted ${len - read}, EOF`);
    read += bytesRead;
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * Parse the 2 GB source's central directory from disk and return the
 * verbatim-copy source list — each entry's name/method/sizes/CRC plus the
 * absolute byte offset where its DATA begins.
 */
async function loadSources(fh: Awaited<ReturnType<typeof open>>, total: number): Promise<SourceEntry[]> {
  const tailLen = Math.min(TAIL_SCAN, total);
  const tailStart = total - tailLen;
  const tail = await readExact(fh, tailStart, tailLen);
  const loc = locateCentralDirectory(new ByteReader(tail), tailStart);
  if (!loc.ok) throw new Error(`locateCentralDirectory: ${loc.reason}`);

  const cd = await readExact(fh, loc.location.offset, loc.location.size);
  const parsed = parseCentralDirectory(cd, loc.location.entryCount);
  if (!parsed.ok) throw new Error(`parseCentralDirectory: ${parsed.reason}`);

  const sources: SourceEntry[] = [];
  for (const e of parsed.entries) {
    const lh = await readExact(fh, e.localHeaderOffset, 30);
    const dataOff = computeDataOffset(new ByteReader(lh), e.localHeaderOffset);
    if (!dataOff.ok) throw new Error(`computeDataOffset(${e.name}): ${dataOff.reason}`);
    sources.push({
      name: e.name,
      method: e.compressionMethod,
      compressedSize: e.compressedSize,
      uncompressedSize: e.uncompressedSize,
      crc32: e.crc32,
      dataOffset: dataOff.dataOffset,
    });
  }
  return sources;
}

async function build(label: string, outPath: string, target: number): Promise<void> {
  const t0 = Date.now();
  console.log(`\n=== building ${label} -> ${outPath} (target ${(target / GB).toFixed(2)} GiB) ===`);

  const src = await open(SOURCE_PATH, 'r');
  const total = (await src.stat()).size;
  console.log(`source: ${SOURCE_PATH} = ${total} bytes (${(total / GB).toFixed(3)} GiB)`);

  const sources = await loadSources(src, total);
  console.log(`parsed source central directory: ${sources.length} entries`);

  const plan = buildPlan(sources, target);
  console.log(`plan: ${plan.length} output entries`);

  const out = await open(outPath, 'w');
  const copyBuf = Buffer.allocUnsafe(COPY_CHUNK);

  let fileOffset = 0;
  const records: EntryRecord[] = [];

  // Bounded write helper: writes the whole Uint8Array, advancing fileOffset.
  const write = async (bytes: Uint8Array): Promise<void> => {
    let written = 0;
    while (written < bytes.length) {
      const { bytesWritten } = await out.write(bytes, written, bytes.length - written);
      written += bytesWritten;
    }
    fileOffset += bytes.length;
  };

  let lastLog = Date.now();
  for (let i = 0; i < plan.length; i++) {
    const entry = plan[i]!;

    // Fresh ZIP64 local header (offset recorded for the central directory).
    const headerOffset = fileOffset;
    const header = localFileHeader(entry.name, entry.method, 0);
    new DataView(header.buffer).setUint32(14, entry.crc32 >>> 0, true);
    patchLocalZip64(header, entry.name, entry.uncompressedSize, entry.compressedSize);
    await write(header);
    records.push({
      name: entry.name,
      method: entry.method,
      crc32: entry.crc32,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
      localHeaderOffset: headerOffset,
    });

    // Verbatim-copy this entry's DATA from the source, in COPY_CHUNK reads.
    let copied = 0;
    while (copied < entry.compressedSize) {
      const want = Math.min(entry.compressedSize - copied, COPY_CHUNK);
      const start = entry.sourceDataOffset + copied;
      let read = 0;
      while (read < want) {
        const { bytesRead } = await src.read(copyBuf, read, want - read, start + read);
        if (bytesRead === 0) {
          throw new Error(`short read for ${entry.name}: wanted ${want - read} at ${start + read}`);
        }
        read += bytesRead;
      }
      await write(new Uint8Array(copyBuf.buffer, copyBuf.byteOffset, want));
      copied += want;
    }

    if (Date.now() - lastLog > 5000) {
      const pct = ((fileOffset / target) * 100).toFixed(1);
      console.log(`  ${pct}%  entry ${i + 1}/${plan.length}  ${(fileOffset / GB).toFixed(2)} GiB written`);
      lastLog = Date.now();
    }
  }

  // ZIP64 central directory.
  const cdOffset = fileOffset;
  let cdSize = 0;
  for (const rec of records) {
    const cd = centralFileHeader(rec);
    await write(cd);
    cdSize += cd.length;
  }
  // EOCD64 + locator + sentineled classic EOCD.
  const eocd64FileOffset = cdOffset + cdSize;
  await write(endRecords(records.length, cdSize, cdOffset, eocd64FileOffset));

  await out.close();
  await src.close();

  const finalSize = (await stat(outPath)).size;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (finalSize !== fileOffset) {
    throw new Error(`on-disk size ${finalSize} != tracked offset ${fileOffset}`);
  }
  console.log(
    `=== ${label} DONE: ${finalSize} bytes (${(finalSize / GB).toFixed(3)} GiB), ` +
      `${records.length} files, CD@${cdOffset}, in ${secs}s ===`,
  );
}

async function main(): Promise<void> {
  const arg = (process.argv[2] ?? '').toLowerCase();
  const which = arg === 'both' ? ['10gb', '30gb'] : arg ? [arg] : [];
  if (which.length === 0 || which.some((w) => !TARGETS[w])) {
    console.error('usage: bun run build-local.ts 10gb|30gb|both');
    process.exit(1);
  }
  // Confirm the source exists before doing any work.
  await stat(SOURCE_PATH).catch(() => {
    throw new Error(`source not found at ${SOURCE_PATH} — download it first`);
  });
  for (const w of which) {
    const spec = TARGETS[w]!;
    await build(w, spec.out, spec.target);
  }
}

main().catch((err) => {
  console.error('BUILD FAILED:', err);
  process.exit(1);
});

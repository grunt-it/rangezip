/**
 * zip64.ts — hand-written, streaming ZIP64 writer for the sample-builder Worker.
 *
 * Why hand-written and not fflate: fflate's streaming `Zip` encoder writes a
 * fixed 22-byte classic EOCD and 32-bit size/offset fields with NO ZIP64
 * records (verified against node_modules/fflate/esm/index.mjs — `wzh`/`wzf`).
 * For an archive >4 GB those 32-bit fields silently overflow and rangezip's
 * parser (which keys ZIP64 promotion off the 0xFFFFFFFF sentinel) would read
 * garbage offsets. So we emit a fully ZIP64-correct archive ourselves.
 *
 * Layout produced (the shape rangezip's `src/zip` reads):
 *   per entry:  local file header (0x04034b50) + ZIP64 extra (0x0001) + data
 *   tail:       central directory (one 0x02014b50 header per entry, each with a
 *               ZIP64 extra carrying the fields whose 32-bit slot is sentinel)
 *               + ZIP64 EOCD (0x06064b50) + ZIP64 EOCD locator (0x07064b50)
 *               + classic EOCD (0x06054b50) with sentinels.
 *
 * Memory discipline: this module produces small byte records (headers) and the
 * caller streams file *data* through it in bounded chunks — nothing here ever
 * holds a whole entry, let alone the whole archive.
 *
 * All values are little-endian. We always emit the ZIP64 extra field on BOTH
 * local and central headers and always sentinel the 32-bit size slots, so the
 * format is uniform whether or not a given entry individually exceeds 4 GB.
 */

const U32_SENTINEL = 0xffffffff;

export const Method = { STORED: 0, DEFLATE: 8 } as const;
export type MethodValue = (typeof Method)[keyof typeof Method];

/** Recorded after an entry's local header + data are emitted, for the CD. */
export interface EntryRecord {
  readonly name: string;
  readonly method: MethodValue;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

const textEncoder = new TextEncoder();

function w16(view: DataView, off: number, v: number): void {
  view.setUint16(off, v & 0xffff, true);
}
function w32(view: DataView, off: number, v: number): void {
  view.setUint32(off, v >>> 0, true);
}
function w64(view: DataView, off: number, v: number): void {
  view.setBigUint64(off, BigInt(v), true);
}

/**
 * Build the local file header (+ ZIP64 extra) for an entry.
 *
 * The 32-bit compressed/uncompressed slots are sentinels; the real 64-bit
 * values live in the ZIP64 extra field. Local-header offset is NOT carried in
 * the local extra (it isn't meaningful there) — only uncompressed + compressed.
 *
 * rangezip's `computeDataOffset` reads THIS header's own name+extra lengths to
 * find the data start, so the extra length must be exact.
 */
export function localFileHeader(name: string, method: MethodValue, crc32: number): Uint8Array {
  const nameBytes = textEncoder.encode(name);
  // ZIP64 extra: id(2) + size(2) + uncompressed(8) + compressed(8) = 20 bytes
  const zip64ExtraLen = 4 + 16;
  const out = new Uint8Array(30 + nameBytes.length + zip64ExtraLen);
  const view = new DataView(out.buffer);

  w32(view, 0, 0x04034b50); // local file header signature
  w16(view, 4, 45); // version needed (4.5 = ZIP64)
  w16(view, 6, 0); // general purpose flag (no data descriptor; sizes are known)
  w16(view, 8, method); // compression method
  w16(view, 10, 0); // mod time
  w16(view, 12, 0); // mod date
  w32(view, 14, crc32); // crc-32
  w32(view, 18, U32_SENTINEL); // compressed size -> ZIP64
  w32(view, 22, U32_SENTINEL); // uncompressed size -> ZIP64
  w16(view, 26, nameBytes.length); // filename length
  w16(view, 28, zip64ExtraLen); // extra field length

  out.set(nameBytes, 30);

  // ZIP64 extra field (positional: uncompressed, then compressed). We fill the
  // 64-bit values with the SAME sentinel at write time; the real sizes for the
  // local header aren't known until data is streamed, but rangezip never reads
  // the local extra's values — it reads sizes from the CENTRAL directory and
  // uses the local header only for name+extra LENGTHS (to find the data start).
  // To keep the archive valid for general tools too, we DO write the real sizes
  // in the central directory's ZIP64 extra. The local extra carries sentinels'
  // placeholders here and is patched-in-place by the caller via patchLocalZip64.
  const extraOff = 30 + nameBytes.length;
  w16(view, extraOff, 0x0001); // ZIP64 header id
  w16(view, extraOff + 2, 16); // data size = 16 (two u64)
  // values written by patchLocalZip64 once sizes are known
  return out;
}

/**
 * The byte length of the ZIP64 extra data region within a local header, and the
 * absolute offset (within the header) where the two u64 values begin. The
 * caller needs this to patch the real sizes into the part buffer in place.
 */
export function localZip64ValueOffset(name: string): number {
  const nameLen = textEncoder.encode(name).length;
  return 30 + nameLen + 4; // skip fixed header + name + (id,size)
}

/** Patch the two u64 values (uncompressed, compressed) into a local-header buffer. */
export function patchLocalZip64(
  header: Uint8Array,
  name: string,
  uncompressedSize: number,
  compressedSize: number,
): void {
  const off = localZip64ValueOffset(name);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  w64(view, off, uncompressedSize);
  w64(view, off + 8, compressedSize);
}

/**
 * Build one central-directory file header for an entry.
 *
 * ZIP64 extra carries, in canonical positional order, ONLY the fields whose
 * 32-bit slot is the sentinel — uncompressed -> compressed -> localHeaderOffset.
 * We sentinel uncompressed + compressed unconditionally, and sentinel the
 * local-header offset only when it actually exceeds 4 GB (matching real-world
 * writers and exercising rangezip's positional resolver either way).
 */
export function centralFileHeader(rec: EntryRecord): Uint8Array {
  const nameBytes = textEncoder.encode(rec.name);

  const offsetNeedsZip64 = rec.localHeaderOffset >= U32_SENTINEL;
  // ZIP64 extra data: uncompressed(8) + compressed(8) [+ localOffset(8)]
  const zip64DataLen = 16 + (offsetNeedsZip64 ? 8 : 0);
  const zip64ExtraLen = 4 + zip64DataLen;

  const out = new Uint8Array(46 + nameBytes.length + zip64ExtraLen);
  const view = new DataView(out.buffer);

  w32(view, 0, 0x02014b50); // central file header signature
  w16(view, 4, 45); // version made by
  w16(view, 6, 45); // version needed (ZIP64)
  w16(view, 8, 0); // general purpose flag
  w16(view, 10, rec.method); // compression method
  w16(view, 12, 0); // mod time
  w16(view, 14, 0); // mod date
  w32(view, 16, rec.crc32); // crc-32
  w32(view, 20, U32_SENTINEL); // compressed size -> ZIP64
  w32(view, 24, U32_SENTINEL); // uncompressed size -> ZIP64
  w16(view, 28, nameBytes.length); // filename length
  w16(view, 30, zip64ExtraLen); // extra field length
  w16(view, 32, 0); // comment length
  w16(view, 34, 0); // disk number start
  w16(view, 36, 0); // internal attrs
  w32(view, 38, 0); // external attrs
  w32(view, 42, offsetNeedsZip64 ? U32_SENTINEL : rec.localHeaderOffset); // local header offset

  out.set(nameBytes, 46);

  const extraOff = 46 + nameBytes.length;
  w16(view, extraOff, 0x0001); // ZIP64 header id
  w16(view, extraOff + 2, zip64DataLen); // data size
  let p = extraOff + 4;
  w64(view, p, rec.uncompressedSize);
  p += 8;
  w64(view, p, rec.compressedSize);
  p += 8;
  if (offsetNeedsZip64) {
    w64(view, p, rec.localHeaderOffset);
    p += 8;
  }
  return out;
}

/**
 * Build the ZIP64 EOCD record + ZIP64 EOCD locator + classic EOCD, in that
 * order, as a single contiguous tail buffer. Offsets are absolute file offsets.
 *
 * @param entryCount         total number of entries.
 * @param cdSize             total bytes of the central directory.
 * @param cdOffset           absolute file offset where the central directory begins.
 * @param eocd64FileOffset   absolute file offset where the ZIP64 EOCD record begins
 *                           (== cdOffset + cdSize).
 */
export function endRecords(
  entryCount: number,
  cdSize: number,
  cdOffset: number,
  eocd64FileOffset: number,
): Uint8Array {
  // ZIP64 EOCD: 56 bytes. Locator: 20 bytes. Classic EOCD: 22 bytes.
  const out = new Uint8Array(56 + 20 + 22);
  const view = new DataView(out.buffer);

  // --- ZIP64 EOCD record (0x06064b50) ---
  w32(view, 0, 0x06064b50);
  w64(view, 4, 44); // size of remaining EOCD64 record (56 - 12)
  w16(view, 12, 45); // version made by
  w16(view, 14, 45); // version needed
  w32(view, 16, 0); // this disk number
  w32(view, 20, 0); // disk with start of CD
  w64(view, 24, entryCount); // entries on this disk
  w64(view, 32, entryCount); // total entries
  w64(view, 40, cdSize); // central directory size
  w64(view, 48, cdOffset); // central directory offset

  // --- ZIP64 EOCD locator (0x07064b50) ---
  const locOff = 56;
  w32(view, locOff, 0x07064b50);
  w32(view, locOff + 4, 0); // disk with ZIP64 EOCD
  w64(view, locOff + 8, eocd64FileOffset); // absolute offset of ZIP64 EOCD
  w32(view, locOff + 16, 1); // total number of disks

  // --- classic EOCD (0x06054b50) with sentinels ---
  const eocdOff = 56 + 20;
  w32(view, eocdOff, 0x06054b50);
  w16(view, eocdOff + 4, 0); // disk number
  w16(view, eocdOff + 6, 0); // disk with start of CD
  w16(view, eocdOff + 8, 0xffff); // entries this disk -> ZIP64
  w16(view, eocdOff + 10, 0xffff); // total entries -> ZIP64
  w32(view, eocdOff + 12, U32_SENTINEL); // CD size -> ZIP64
  w32(view, eocdOff + 16, U32_SENTINEL); // CD offset -> ZIP64
  w16(view, eocdOff + 20, 0); // comment length

  return out;
}

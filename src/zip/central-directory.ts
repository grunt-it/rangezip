/**
 * Parse the central directory into a flat list of {@link ZipEntry}.
 *
 * Pure logic operating on the central-directory bytes that the caller
 * range-GET'd (using the offset/size from {@link locateCentralDirectory}).
 * No IO, no Effect — fully unit-testable from an in-memory buffer.
 */

import { ByteReader } from './byte-reader';
import {
  CompressionMethod,
  FixedSize,
  Signature,
  ZIP64_EXTRA_FIELD_ID,
  ZIP64_SENTINEL_U32,
  type CompressionMethodValue,
  type ZipEntry,
} from './format';

export type ParseCentralDirectoryResult =
  | { readonly ok: true; readonly entries: readonly ZipEntry[] }
  | { readonly ok: false; readonly reason: string };

/**
 * @param cd          the central-directory bytes (exactly the range that the
 *                    EOCD pointed at).
 * @param entryCount  expected number of entries, used as an upper bound so a
 *                    corrupt header can't spin the loop forever.
 */
export function parseCentralDirectory(
  cd: Uint8Array,
  entryCount: number,
): ParseCentralDirectoryResult {
  const reader = new ByteReader(cd);
  const entries: ZipEntry[] = [];
  let offset = 0;

  while (offset + FixedSize.CENTRAL_FILE_HEADER <= reader.length) {
    if (reader.u32(offset) !== Signature.CENTRAL_FILE_HEADER) break;

    const parsed = parseEntry(reader, offset);
    if (!parsed.ok) return parsed;

    entries.push(parsed.entry);
    offset = parsed.nextOffset;

    if (entries.length > entryCount) {
      return { ok: false, reason: 'Central directory has more entries than the EOCD declared' };
    }
  }

  return { ok: true, entries };
}

interface ParsedEntry {
  readonly ok: true;
  readonly entry: ZipEntry;
  readonly nextOffset: number;
}

function parseEntry(
  reader: ByteReader,
  base: number,
): ParsedEntry | { readonly ok: false; readonly reason: string } {
  // Central file header layout (offsets relative to the signature):
  //   10: u16 compression method
  //   16: u32 crc-32
  //   20: u32 compressed size
  //   24: u32 uncompressed size
  //   28: u16 filename length (n)
  //   30: u16 extra field length (m)
  //   32: u16 comment length (k)
  //   42: u32 local-header offset
  //   46: filename (n) | extra (m) | comment (k)
  const method = reader.u16(base + 10);
  const crc32 = reader.u32(base + 16);
  const nameLength = reader.u16(base + 28);
  const extraLength = reader.u16(base + 30);
  const commentLength = reader.u16(base + 32);

  const nameStart = base + FixedSize.CENTRAL_FILE_HEADER;
  const extraStart = nameStart + nameLength;
  const commentStart = extraStart + extraLength;
  const nextOffset = commentStart + commentLength;

  if (nextOffset > reader.length) {
    return { ok: false, reason: 'Central directory entry extends past the buffer' };
  }

  if (method !== CompressionMethod.STORED && method !== CompressionMethod.DEFLATE) {
    return {
      ok: false,
      reason: `Unsupported compression method ${method} for "${reader.utf8(nameStart, nameLength)}" (only STORED and DEFLATE are supported)`,
    };
  }

  const name = reader.utf8(nameStart, nameLength);

  // Read the 32-bit fields, then let ZIP64 promote any that are sentinels.
  // The ZIP64 extra field carries ONLY the fields whose 32-bit slot held the
  // sentinel, in this fixed order: uncompressed, compressed, local offset.
  const sizes = resolveSizes(reader, base, extraStart, extraLength);

  return {
    ok: true,
    entry: {
      name,
      compressionMethod: method as CompressionMethodValue,
      compressedSize: sizes.compressedSize,
      uncompressedSize: sizes.uncompressedSize,
      localHeaderOffset: sizes.localHeaderOffset,
      crc32,
    },
    nextOffset,
  };
}

interface ResolvedSizes {
  readonly uncompressedSize: number;
  readonly compressedSize: number;
  readonly localHeaderOffset: number;
}

/**
 * Resolve the three size/offset fields, promoting any 32-bit sentinel to its
 * 64-bit counterpart from the ZIP64 extra field.
 *
 * Critically, the ZIP64 extra field is POSITIONAL: it contains 8-byte values
 * only for the fields that overflowed, in the canonical order
 * (uncompressed → compressed → local-header-offset). We walk it in that order,
 * consuming a value only when the matching 32-bit field is the sentinel.
 */
function resolveSizes(
  reader: ByteReader,
  base: number,
  extraStart: number,
  extraLength: number,
): ResolvedSizes {
  const u32Compressed = reader.u32(base + 20);
  const u32Uncompressed = reader.u32(base + 24);
  const u32LocalOffset = reader.u32(base + 42);

  const needsUncompressed = u32Uncompressed === ZIP64_SENTINEL_U32;
  const needsCompressed = u32Compressed === ZIP64_SENTINEL_U32;
  const needsLocalOffset = u32LocalOffset === ZIP64_SENTINEL_U32;

  let uncompressedSize = u32Uncompressed;
  let compressedSize = u32Compressed;
  let localHeaderOffset = u32LocalOffset;

  if (needsUncompressed || needsCompressed || needsLocalOffset) {
    const zip64 = findZip64ExtraField(reader, extraStart, extraLength);
    if (zip64) {
      let cursor = zip64.dataStart;
      if (needsUncompressed) {
        uncompressedSize = reader.u64(cursor);
        cursor += 8;
      }
      if (needsCompressed) {
        compressedSize = reader.u64(cursor);
        cursor += 8;
      }
      if (needsLocalOffset) {
        localHeaderOffset = reader.u64(cursor);
        cursor += 8;
      }
    }
  }

  return { uncompressedSize, compressedSize, localHeaderOffset };
}

/**
 * Walk the extra-field block (a sequence of `id:u16, size:u16, data[size]`
 * sub-records) and return where the ZIP64 sub-record's data begins.
 */
function findZip64ExtraField(
  reader: ByteReader,
  extraStart: number,
  extraLength: number,
): { readonly dataStart: number } | null {
  let cursor = extraStart;
  const end = extraStart + extraLength;

  while (cursor + 4 <= end) {
    const id = reader.u16(cursor);
    const size = reader.u16(cursor + 2);
    const dataStart = cursor + 4;
    if (id === ZIP64_EXTRA_FIELD_ID) return { dataStart };
    cursor = dataStart + size;
  }

  return null;
}

/**
 * Locate the central directory by parsing the End-Of-Central-Directory record
 * from the TAIL bytes of the archive.
 *
 * Pure logic: the caller range-GETs the last N bytes of the file and hands us
 * the slice plus where in the overall file that slice begins (`tailFileOffset`)
 * so we can translate record-relative offsets back into absolute file offsets.
 *
 * Flow:
 *   1. Find the classic EOCD (0x06054b50) by scanning backwards.
 *   2. If its CD offset / size / count are sentinel values (archive is >4 GB or
 *      has >65535 entries), follow the ZIP64 EOCD locator (0x07064b50) to the
 *      ZIP64 EOCD record (0x06064b50) and read the real 64-bit values.
 */

import type { ByteReader } from './byte-reader';
import {
  FixedSize,
  Signature,
  ZIP64_SENTINEL_U16,
  ZIP64_SENTINEL_U32,
  type CentralDirectoryLocation,
} from './format';

/** Discriminated outcome — never throws for "expected" parse failures. */
export type EocdResult =
  | { readonly ok: true; readonly location: CentralDirectoryLocation }
  | { readonly ok: false; readonly reason: string };

/**
 * @param tail            bytes from the end of the archive (last ~64 KB).
 * @param tailFileOffset  absolute offset within the whole file at which `tail`
 *                        begins. For a full-file buffer this is 0.
 */
export function locateCentralDirectory(tail: ByteReader, tailFileOffset: number): EocdResult {
  const eocdRel = tail.findLastSignature(Signature.EOCD);
  if (eocdRel < 0) {
    return {
      ok: false,
      reason: 'End-Of-Central-Directory signature not found in the scanned tail',
    };
  }
  if (eocdRel + FixedSize.EOCD > tail.length) {
    return { ok: false, reason: 'EOCD record is truncated within the scanned tail' };
  }

  // Classic EOCD layout (offsets relative to the signature):
  //   16: u32 central-directory offset (from start of file)
  //   12: u32 central-directory size
  //   10: u16 total entry count
  const cdOffset = tail.u32(eocdRel + 16);
  const cdSize = tail.u32(eocdRel + 12);
  const entryCount = tail.u16(eocdRel + 10);

  const needsZip64 =
    cdOffset === ZIP64_SENTINEL_U32 ||
    cdSize === ZIP64_SENTINEL_U32 ||
    entryCount === ZIP64_SENTINEL_U16;

  if (!needsZip64) {
    return { ok: true, location: { offset: cdOffset, size: cdSize, entryCount } };
  }

  return locateViaZip64(tail, tailFileOffset, eocdRel);
}

/**
 * Resolve the central directory through the ZIP64 records. The locator sits
 * `FixedSize.EOCD64_LOCATOR` bytes before the classic EOCD and points (by
 * absolute file offset) at the ZIP64 EOCD record.
 */
function locateViaZip64(tail: ByteReader, tailFileOffset: number, eocdRel: number): EocdResult {
  const locatorRel = eocdRel - FixedSize.EOCD64_LOCATOR;
  if (locatorRel < 0 || tail.u32(locatorRel) !== Signature.EOCD64_LOCATOR) {
    return {
      ok: false,
      reason: 'EOCD reports ZIP64 sentinels but the ZIP64 locator is missing',
    };
  }

  // Locator layout (relative to its signature):
  //   8: u64 absolute file offset of the ZIP64 EOCD record
  const eocd64FileOffset = tail.u64(locatorRel + 8);
  const eocd64Rel = eocd64FileOffset - tailFileOffset;

  if (eocd64Rel < 0) {
    return {
      ok: false,
      reason: 'ZIP64 EOCD record lies before the scanned tail — grow the tail read and retry',
    };
  }
  if (eocd64Rel + FixedSize.EOCD64 > tail.length) {
    return { ok: false, reason: 'ZIP64 EOCD record is truncated within the scanned tail' };
  }
  if (tail.u32(eocd64Rel) !== Signature.EOCD64) {
    return { ok: false, reason: 'ZIP64 EOCD signature mismatch at the located offset' };
  }

  // ZIP64 EOCD layout (relative to its signature):
  //   24: u64 total entry count
  //   40: u64 central-directory size
  //   48: u64 central-directory offset (from start of file)
  const entryCount = tail.u64(eocd64Rel + 24);
  const cdSize = tail.u64(eocd64Rel + 40);
  const cdOffset = tail.u64(eocd64Rel + 48);

  return { ok: true, location: { offset: cdOffset, size: cdSize, entryCount } };
}

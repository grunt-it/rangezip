/**
 * Compute the exact byte offset where an entry's (compressed) data begins.
 *
 * This is the subtle part of range-based ZIP reading. The central directory
 * gives us `localHeaderOffset`, but it does NOT tell us where the data starts —
 * the local file header has its OWN filename-length and extra-field-length
 * fields, and the extra field in particular is routinely a DIFFERENT length
 * from the central directory's (writers pad alignment differently, drop the
 * ZIP64 block, etc.). So we must range-GET the 30-byte fixed local header and
 * read its own lengths to find where the data truly begins:
 *
 *   dataOffset = localHeaderOffset
 *              + 30 (fixed local header)
 *              + localNameLength
 *              + localExtraLength
 *
 * Pure logic: the caller range-GETs the 30 bytes at `localHeaderOffset` and
 * passes them here.
 */

import type { ByteReader } from './byte-reader';
import { FixedSize, Signature } from './format';

export type LocalDataOffsetResult =
  | { readonly ok: true; readonly dataOffset: number }
  | { readonly ok: false; readonly reason: string };

/**
 * @param localHeader       the 30 fixed bytes at `localHeaderOffset`.
 * @param localHeaderOffset that entry's absolute local-header offset (from the
 *                          central directory).
 */
export function computeDataOffset(
  localHeader: ByteReader,
  localHeaderOffset: number,
): LocalDataOffsetResult {
  if (localHeader.length < FixedSize.LOCAL_FILE_HEADER) {
    return { ok: false, reason: 'Local file header range is shorter than 30 bytes' };
  }
  if (localHeader.u32(0) !== Signature.LOCAL_FILE_HEADER) {
    return {
      ok: false,
      reason: `Local file header signature mismatch at offset ${localHeaderOffset}`,
    };
  }

  // Local file header layout (offsets relative to the signature):
  //   26: u16 filename length
  //   28: u16 extra field length
  const nameLength = localHeader.u16(26);
  const extraLength = localHeader.u16(28);

  const dataOffset = localHeaderOffset + FixedSize.LOCAL_FILE_HEADER + nameLength + extraLength;

  return { ok: true, dataOffset };
}

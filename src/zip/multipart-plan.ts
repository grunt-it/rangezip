/**
 * Pure part-planning for the parallel multipart path (large STORED entries).
 *
 * Given a STORED entry's absolute data offset + uncompressed size and a target
 * part size, produce the list of absolute byte ranges to range-GET and the part
 * number each maps to. This is the off-by-one-prone arithmetic the repo keeps
 * pure + unit-tested (see CLAUDE.md): no IO, no Effect — just numbers in, a
 * `{ ok }` / `{ ok: false }` result out, so the Effect shell can map a planning
 * failure to a typed error.
 *
 * R2 multipart constraints this planner must honour (CF R2 docs):
 *   - Minimum part size 5 MiB, EXCEPT the last part may be smaller.
 *   - All non-last parts must be the SAME size (error 10048 otherwise).
 *   - Maximum 10,000 parts.
 *   - Maximum part size 5 GiB.
 * The planner enforces these by construction: every non-last part is exactly
 * `partSize`; the last part is the remainder. It rejects a `partSize` below the
 * 5 MiB floor or above the 5 GiB ceiling, and a plan that would exceed 10k parts.
 */

/** R2's hard floor on a non-final part. */
export const R2_MIN_PART_BYTES = 5 * 1024 * 1024;
/** R2's hard ceiling on any single part. */
export const R2_MAX_PART_BYTES = 5 * 1024 * 1024 * 1024;
/** R2's hard cap on the number of parts in one multipart upload. */
export const R2_MAX_PARTS = 10_000;

/** One planned part: a 1-based part number and the absolute `[offset, offset+length)` to fetch. */
export interface PartPlan {
  /** R2 part numbers are 1-based and must be ascending. */
  readonly partNumber: number;
  /** Absolute byte offset within the SOURCE archive (data offset + intra-entry offset). */
  readonly offset: number;
  /** Number of bytes in this part. Equals `partSize` for every part but the last. */
  readonly length: number;
}

export type PlanPartsResult =
  | { readonly ok: true; readonly parts: readonly PartPlan[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Plan the parts for streaming `[dataOffset, dataOffset + size)` to R2 as a
 * multipart upload of `partSize`-sized chunks.
 *
 * Every part but the last is exactly `partSize` bytes; the last carries the
 * remainder. The returned offsets are ABSOLUTE (already include `dataOffset`),
 * so each maps straight to a `Source.streamRange({ start, end })`.
 *
 * Returns `ok: false` (never throws) when the inputs can't yield a valid R2
 * multipart plan, so the caller stays on the single-stream path or fails with a
 * typed error rather than a defect.
 */
export function planMultipartParts(
  dataOffset: number,
  size: number,
  partSize: number,
): PlanPartsResult {
  if (!Number.isInteger(dataOffset) || dataOffset < 0) {
    return { ok: false, reason: `dataOffset must be a non-negative integer (got ${dataOffset})` };
  }
  if (!Number.isInteger(size) || size <= 0) {
    return { ok: false, reason: `size must be a positive integer (got ${size})` };
  }
  if (!Number.isInteger(partSize) || partSize < R2_MIN_PART_BYTES) {
    return {
      ok: false,
      reason: `partSize must be an integer >= ${R2_MIN_PART_BYTES} (5 MiB); got ${partSize}`,
    };
  }
  if (partSize > R2_MAX_PART_BYTES) {
    return {
      ok: false,
      reason: `partSize must be <= ${R2_MAX_PART_BYTES} (5 GiB); got ${partSize}`,
    };
  }

  // Number of parts: full chunks of `partSize`, with a final remainder part.
  const partCount = Math.ceil(size / partSize);
  if (partCount > R2_MAX_PARTS) {
    return {
      ok: false,
      reason: `plan needs ${partCount} parts, exceeding R2's max of ${R2_MAX_PARTS}; use a larger partSize`,
    };
  }

  const parts: PartPlan[] = [];
  let consumed = 0;
  for (let i = 0; i < partCount; i++) {
    // Every part is `partSize` except the last, which takes whatever remains.
    const length = Math.min(partSize, size - consumed);
    parts.push({
      partNumber: i + 1,
      offset: dataOffset + consumed,
      length,
    });
    consumed += length;
  }

  // Invariant: the planned ranges exactly cover `[dataOffset, dataOffset + size)`.
  // (Guards against an arithmetic slip — cheap to assert, returned as a typed
  // failure rather than a defect.)
  if (consumed !== size) {
    return { ok: false, reason: `internal: planned ${consumed} bytes, expected ${size}` };
  }

  return { ok: true, parts };
}

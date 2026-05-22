/**
 * Pure unit tests for the multipart part-planner. No runtime, no IO — exactly
 * the off-by-one-prone arithmetic the repo keeps pure + tested (CLAUDE.md).
 */

import { describe, expect, it } from 'vitest';
import { planMultipartParts, R2_MAX_PARTS, R2_MIN_PART_BYTES, R2_MAX_PART_BYTES } from '../src/zip';

const MIB = 1024 * 1024;

describe('planMultipartParts', () => {
  it('splits an exact multiple of partSize into equal parts', () => {
    const result = planMultipartParts(0, 15 * MIB, 5 * MIB);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parts).toEqual([
      { partNumber: 1, offset: 0, length: 5 * MIB },
      { partNumber: 2, offset: 5 * MIB, length: 5 * MIB },
      { partNumber: 3, offset: 10 * MIB, length: 5 * MIB },
    ]);
  });

  it('makes the LAST part the (smaller) remainder, all others equal', () => {
    const result = planMultipartParts(0, 13 * MIB, 5 * MIB);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parts).toEqual([
      { partNumber: 1, offset: 0, length: 5 * MIB },
      { partNumber: 2, offset: 5 * MIB, length: 5 * MIB },
      { partNumber: 3, offset: 10 * MIB, length: 3 * MIB },
    ]);
  });

  it('offsets are ABSOLUTE — dataOffset is added to every part', () => {
    const dataOffset = 1_000_000;
    const result = planMultipartParts(dataOffset, 12 * MIB, 5 * MIB);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parts.map((p) => p.offset)).toEqual([
      dataOffset,
      dataOffset + 5 * MIB,
      dataOffset + 10 * MIB,
    ]);
    // The last (remainder) part runs to exactly dataOffset + size.
    const last = result.parts[result.parts.length - 1]!;
    expect(last.offset + last.length).toBe(dataOffset + 12 * MIB);
  });

  it('the planned ranges exactly tile [dataOffset, dataOffset + size) with no gaps/overlaps', () => {
    const dataOffset = 42;
    const size = 5 * MIB + 5 * MIB + 1; // forces a tiny 1-byte final part
    const result = planMultipartParts(dataOffset, size, 5 * MIB);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    let cursor = dataOffset;
    let total = 0;
    for (const part of result.parts) {
      expect(part.offset).toBe(cursor); // contiguous, no gap or overlap
      cursor += part.length;
      total += part.length;
    }
    expect(total).toBe(size);
    expect(cursor).toBe(dataOffset + size);
    // Part numbers are 1-based and ascending.
    expect(result.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
  });

  it('produces a single part when size <= partSize (one full or partial chunk)', () => {
    const result = planMultipartParts(7, 4 * MIB, 5 * MIB);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parts).toEqual([{ partNumber: 1, offset: 7, length: 4 * MIB }]);
  });

  it('every non-last part is at least R2_MIN_PART_BYTES', () => {
    const result = planMultipartParts(0, 23 * MIB, R2_MIN_PART_BYTES);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const nonLast = result.parts.slice(0, -1);
    for (const part of nonLast) {
      expect(part.length).toBeGreaterThanOrEqual(R2_MIN_PART_BYTES);
    }
  });

  it('rejects a partSize below R2 minimum (5 MiB)', () => {
    const result = planMultipartParts(0, 100 * MIB, R2_MIN_PART_BYTES - 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/5 MiB|>=/);
  });

  it('rejects a partSize above R2 maximum (5 GiB)', () => {
    const result = planMultipartParts(0, 100 * MIB, R2_MAX_PART_BYTES + 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/5 GiB|<=/);
  });

  it('rejects a plan that would exceed R2_MAX_PARTS', () => {
    // size / partSize > 10_000 parts.
    const size = (R2_MAX_PARTS + 1) * R2_MIN_PART_BYTES;
    const result = planMultipartParts(0, size, R2_MIN_PART_BYTES);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(new RegExp(String(R2_MAX_PARTS)));
  });

  it('rejects non-positive size and negative offset', () => {
    expect(planMultipartParts(0, 0, 5 * MIB).ok).toBe(false);
    expect(planMultipartParts(-1, 10 * MIB, 5 * MIB).ok).toBe(false);
    expect(planMultipartParts(0, -10, 5 * MIB).ok).toBe(false);
  });

  it('rejects non-integer inputs (no fractional byte ranges)', () => {
    expect(planMultipartParts(0.5, 10 * MIB, 5 * MIB).ok).toBe(false);
    expect(planMultipartParts(0, 10.5, 5 * MIB).ok).toBe(false);
    expect(planMultipartParts(0, 10 * MIB, 5 * MIB + 0.5).ok).toBe(false);
  });
});

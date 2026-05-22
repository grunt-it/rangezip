/**
 * Pure progress-helper test: the overall-percentage math the UI bar renders.
 */

import { describe, expect, it } from 'vitest';
import { overallPercent } from '../src/progress';

describe('overallPercent', () => {
  it('is 0 when nothing is done', () => {
    expect(overallPercent(0, 0, 10)).toBe(0);
  });
  it('counts done + failed as settled', () => {
    expect(overallPercent(3, 2, 10)).toBe(50);
  });
  it('is 100 when all settled', () => {
    expect(overallPercent(8, 2, 10)).toBe(100);
  });
  it('is 0 (not NaN) when total is 0', () => {
    expect(overallPercent(0, 0, 0)).toBe(0);
  });
  it('clamps to total if counters overshoot (defensive)', () => {
    expect(overallPercent(12, 0, 10)).toBe(100);
  });
  it('rounds to one decimal place', () => {
    expect(overallPercent(1, 0, 3)).toBe(33.3);
  });
});

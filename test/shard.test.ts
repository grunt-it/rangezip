/**
 * Unit tests for the pure sharding logic (`src/shard.ts`).
 *
 * These run with no runtime — they operate over synthetic `ZipEntry` records.
 * The contract under test is the multi-user / parallelism invariant: every
 * selected entry is assigned to exactly one worker (no drops, no dupes), the
 * worker count scales with the job but is capped, and the balance-by-bytes
 * heuristic keeps the heaviest shard from running away.
 */

import { describe, expect, it } from 'vitest';
import {
  chooseWorkerCount,
  shardEntries,
  DEFAULT_MAX_WORKERS,
  type ShardOptions,
} from '../src/shard';
import { CompressionMethod, type ZipEntry } from '../src/zip';

/** Build a synthetic entry of a given name + uncompressed size. */
function entry(name: string, size: number): ZipEntry {
  return {
    name,
    compressionMethod: CompressionMethod.STORED,
    compressedSize: size,
    uncompressedSize: size,
    localHeaderOffset: 0,
    crc32: 0,
  };
}

const SMALL_FANOUT: ShardOptions = { maxWorkers: 4, filesPerWorker: 2 };

describe('chooseWorkerCount', () => {
  it('returns 0 for an empty job', () => {
    expect(chooseWorkerCount(0, SMALL_FANOUT)).toBe(0);
  });

  it('returns at least 1 when there is any work', () => {
    expect(chooseWorkerCount(1, SMALL_FANOUT)).toBe(1);
  });

  it('scales with file count: ceil(files / filesPerWorker)', () => {
    expect(chooseWorkerCount(2, SMALL_FANOUT)).toBe(1); // ceil(2/2)
    expect(chooseWorkerCount(3, SMALL_FANOUT)).toBe(2); // ceil(3/2)
    expect(chooseWorkerCount(5, SMALL_FANOUT)).toBe(3); // ceil(5/2)
  });

  it('never exceeds maxWorkers', () => {
    expect(chooseWorkerCount(1000, SMALL_FANOUT)).toBe(4); // capped
  });

  it('caps at the default ~24 for a large job', () => {
    expect(chooseWorkerCount(10_000)).toBe(DEFAULT_MAX_WORKERS);
  });
});

describe('shardEntries — assignment invariants', () => {
  it('returns no shards for an empty entry list', () => {
    expect(shardEntries([], SMALL_FANOUT)).toEqual([]);
  });

  it('assigns every entry exactly once across all shards (no drops, no dupes)', () => {
    const entries = Array.from({ length: 17 }, (_e, i) => entry(`f${i}.bin`, (i + 1) * 100));
    const shards = shardEntries(entries, SMALL_FANOUT);

    const assigned = shards.flatMap((s) => s.entries.map((e) => e.name));
    // Same multiset of names, every one present, none duplicated.
    expect(assigned.slice().sort()).toEqual(
      entries
        .map((e) => e.name)
        .slice()
        .sort(),
    );
    expect(new Set(assigned).size).toBe(entries.length);
  });

  it('produces no more shards than entries (no empty shards for tiny jobs)', () => {
    const entries = [entry('only.bin', 10)];
    const shards = shardEntries(entries, SMALL_FANOUT);
    expect(shards.length).toBe(1);
    expect(shards[0]!.entries.length).toBe(1);
  });

  it('numbers shards 0..n-1 contiguously', () => {
    const entries = Array.from({ length: 8 }, (_e, i) => entry(`f${i}`, 10));
    const shards = shardEntries(entries, SMALL_FANOUT);
    expect(shards.map((s) => s.index)).toEqual(shards.map((_s, i) => i));
  });

  it('records each shard totalBytes as the sum of its entries', () => {
    const entries = Array.from({ length: 6 }, (_e, i) => entry(`f${i}`, (i + 1) * 1000));
    const shards = shardEntries(entries, SMALL_FANOUT);
    for (const shard of shards) {
      const sum = shard.entries.reduce((acc, e) => acc + e.uncompressedSize, 0);
      expect(shard.totalBytes).toBe(sum);
    }
    // And the grand total is conserved.
    const grand = shards.reduce((acc, s) => acc + s.totalBytes, 0);
    expect(grand).toBe(entries.reduce((acc, e) => acc + e.uncompressedSize, 0));
  });
});

describe('shardEntries — balance by bytes', () => {
  it('does NOT pile all the big entries onto one worker', () => {
    // One enormous file + many tiny ones. A count-based split could put the big
    // file alone with a tiny one and dump the rest elsewhere unevenly; the LPT
    // heuristic spreads the small files to compensate for the big one.
    const big = entry('huge.png', 1_000_000);
    const smalls = Array.from({ length: 9 }, (_e, i) => entry(`t${i}.txt`, 1000));
    const shards = shardEntries([big, ...smalls], { maxWorkers: 3, filesPerWorker: 4 });
    expect(shards.length).toBe(3);

    const totals = shards.map((s) => s.totalBytes).sort((a, b) => a - b);
    // LPT guarantees the heaviest shard is within one max-entry of every other;
    // here the single 1M entry dominates, so the heaviest holds it. The point is
    // the OTHER two shards split the small bytes roughly evenly between them.
    const [lightest, middle] = totals;
    // The two non-huge shards each carry several smalls — neither is empty/idle.
    expect(lightest!).toBeGreaterThan(0);
    expect(middle!).toBeGreaterThan(0);
  });

  it('keeps the heaviest shard within one max-entry of the lightest (LPT bound)', () => {
    // Uniform-ish sizes spread across workers should be near-perfectly balanced.
    const entries = Array.from({ length: 20 }, (_e, i) => entry(`f${i}`, 100 + (i % 5)));
    const shards = shardEntries(entries, { maxWorkers: 4, filesPerWorker: 2 });
    const totals = shards.map((s) => s.totalBytes);
    const maxEntry = Math.max(...entries.map((e) => e.uncompressedSize));
    const spread = Math.max(...totals) - Math.min(...totals);
    expect(spread).toBeLessThanOrEqual(maxEntry);
  });

  it('is deterministic for a given input (ties break to the lowest index)', () => {
    const entries = Array.from({ length: 12 }, (_e, i) => entry(`f${i}`, 100));
    const a = shardEntries(entries, SMALL_FANOUT);
    const b = shardEntries(entries, SMALL_FANOUT);
    expect(a.map((s) => s.entries.map((e) => e.name))).toEqual(
      b.map((s) => s.entries.map((e) => e.name)),
    );
  });

  it('does not mutate the input array order', () => {
    const entries = [entry('a', 1), entry('b', 100), entry('c', 50)];
    const before = entries.map((e) => e.name);
    shardEntries(entries, SMALL_FANOUT);
    expect(entries.map((e) => e.name)).toEqual(before);
  });
});

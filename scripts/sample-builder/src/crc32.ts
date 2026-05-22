/**
 * crc32.ts — CRC-32 (IEEE, the variant ZIP uses) with zlib-style combine.
 *
 * Why combine: a STORED filler file is the same ~1 MiB pattern buffer repeated
 * N times (plus a tail remainder). Re-running a byte-by-byte CRC over tens of
 * GB would burn real CPU. Instead we CRC the pattern ONCE, then use the
 * GF(2)-matrix `crc32Combine` to fold that per-block CRC across the repeats in
 * O(log totalLength) matrix multiplies — the exact algorithm `zlib`'s
 * `crc32_combine` uses. The DEFLATE text files are tiny, so they just use the
 * straightforward streaming `crc32`.
 */

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

/** Streaming CRC-32. Pass the running value (start with 0) and a chunk. */
export function crc32Update(crc: number, data: Uint8Array): number {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) {
    c = (CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** One-shot CRC-32 of a buffer. */
export function crc32(data: Uint8Array): number {
  return crc32Update(0, data);
}

// --- crc32_combine (zlib algorithm) ----------------------------------------

function gf2MatrixTimes(mat: Uint32Array, vec: number): number {
  let sum = 0;
  let v = vec >>> 0;
  let i = 0;
  while (v) {
    if (v & 1) sum ^= mat[i]!;
    v >>>= 1;
    i++;
  }
  return sum >>> 0;
}

function gf2MatrixSquare(square: Uint32Array, mat: Uint32Array): void {
  for (let n = 0; n < 32; n++) square[n] = gf2MatrixTimes(mat, mat[n]!);
}

/**
 * Combine CRC-32 of two consecutive blocks. `crc1` is the CRC of the first
 * block, `crc2` the CRC of the second block (computed as if it stood alone),
 * `len2` the length of the second block in bytes. Returns the CRC of the
 * concatenation. Mirrors zlib `crc32_combine`.
 */
export function crc32Combine(crc1: number, crc2: number, len2: number): number {
  if (len2 <= 0) return crc1 >>> 0;

  let even = new Uint32Array(32); // even-power-of-two zeros operator
  let odd = new Uint32Array(32); // odd-power-of-two zeros operator

  // put operator for one zero bit in odd
  odd[0] = 0xedb88320; // CRC-32 polynomial
  let row = 1;
  for (let n = 1; n < 32; n++) {
    odd[n] = row;
    row <<= 1;
  }

  gf2MatrixSquare(even, odd); // one zero byte step
  gf2MatrixSquare(odd, even); // two zero bytes

  let crc = crc1 >>> 0;
  let len = len2;
  do {
    gf2MatrixSquare(even, odd);
    if (len & 1) crc = gf2MatrixTimes(even, crc);
    len >>>= 1;
    if (len === 0) break;

    gf2MatrixSquare(odd, even);
    if (len & 1) crc = gf2MatrixTimes(odd, crc);
    len >>>= 1;
  } while (len !== 0);

  crc ^= crc2 >>> 0;
  return crc >>> 0;
}

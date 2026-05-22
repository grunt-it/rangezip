/**
 * Little-endian binary reader over a `Uint8Array`.
 *
 * ZIP stores all of its multi-byte integers little-endian. Rather than scatter
 * `DataView` calls (and their endianness flag) across the parser, every read
 * goes through this one place. It is pure — no IO, no Effect — so the parsing
 * functions that build on it stay trivially unit-testable.
 */
export class ByteReader {
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get length(): number {
    return this.bytes.byteLength;
  }

  u16(offset: number): number {
    return this.view.getUint16(offset, true);
  }

  u32(offset: number): number {
    return this.view.getUint32(offset, true);
  }

  /**
   * Read a 64-bit little-endian unsigned integer as a `number`.
   *
   * ZIP64 fields are genuinely 64-bit, but JavaScript numbers stay exact only
   * up to 2^53 - 1. That ceiling is ~9 PB — far beyond any archive a Worker
   * would range-read — so we surface a thrown error rather than silently
   * returning a lossy value. Callers parsing untrusted archives should treat
   * this as a parse failure (see `ZipParseError` at the Effect boundary).
   */
  u64(offset: number): number {
    const value = this.view.getBigUint64(offset, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(`ZIP64 value at offset ${offset} exceeds Number.MAX_SAFE_INTEGER`);
    }
    return Number(value);
  }

  /** Decode `length` bytes starting at `offset` as UTF-8 (ZIP filenames). */
  utf8(offset: number, length: number): string {
    return new TextDecoder('utf-8').decode(this.bytes.subarray(offset, offset + length));
  }

  /** Raw slice — used to hand extra-field blocks to the ZIP64 sub-parser. */
  slice(offset: number, length: number): Uint8Array {
    return this.bytes.subarray(offset, offset + length);
  }

  /**
   * Find the LAST occurrence of a 4-byte little-endian signature.
   *
   * The End-Of-Central-Directory record lives at the very tail of the archive,
   * after a variable-length comment, so we scan backwards to find it reliably
   * even when the same signature bytes happen to appear earlier in the data.
   * Returns -1 when not found.
   */
  findLastSignature(signature: number): number {
    for (let offset = this.length - 4; offset >= 0; offset--) {
      if (this.u32(offset) === signature) return offset;
    }
    return -1;
  }
}

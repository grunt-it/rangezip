/**
 * ZIP on-disk format constants and the parsed shapes the rest of the app
 * consumes. Reference: PKWARE APPNOTE.TXT (the .ZIP File Format Specification).
 *
 * Everything here is data; the parsing logic lives in `central-directory.ts`
 * and `local-header.ts`.
 */

/** 4-byte little-endian record signatures. */
export const Signature = {
  /** Local file header — precedes each file's (optionally compressed) data. */
  LOCAL_FILE_HEADER: 0x04034b50,
  /** Central-directory file header — one per entry, in the index at the tail. */
  CENTRAL_FILE_HEADER: 0x02014b50,
  /** End of central directory. */
  EOCD: 0x06054b50,
  /** ZIP64 end of central directory record. */
  EOCD64: 0x06064b50,
  /** ZIP64 end of central directory locator. */
  EOCD64_LOCATOR: 0x07064b50,
} as const;

/** Compression methods we support. Anything else is rejected at parse time. */
export const CompressionMethod = {
  /** No compression — the stored bytes ARE the file bytes. */
  STORED: 0,
  /** Raw DEFLATE — inflate with `DecompressionStream('deflate-raw')`. */
  DEFLATE: 8,
} as const;

export type CompressionMethodValue = (typeof CompressionMethod)[keyof typeof CompressionMethod];

/**
 * The sentinel value (0xFFFFFFFF) ZIP writes into a 32-bit field when the real
 * value doesn't fit and has been promoted to a ZIP64 extra field.
 */
export const ZIP64_SENTINEL_U32 = 0xffffffff;
/** Same idea for the 16-bit entry-count fields in the classic EOCD. */
export const ZIP64_SENTINEL_U16 = 0xffff;

/** Fixed byte sizes of the records (excluding their variable-length tails). */
export const FixedSize = {
  EOCD: 22,
  EOCD64: 56,
  EOCD64_LOCATOR: 20,
  CENTRAL_FILE_HEADER: 46,
  LOCAL_FILE_HEADER: 30,
} as const;

/** ZIP64 extra-field tag (header ID) inside an entry's extra field. */
export const ZIP64_EXTRA_FIELD_ID = 0x0001;

/**
 * One entry from the central directory — the canonical description of a file
 * inside the archive. `localHeaderOffset` points at the LOCAL header, whose
 * own (independent) name/extra lengths must be read to find the data start.
 */
export interface ZipEntry {
  readonly name: string;
  readonly compressionMethod: CompressionMethodValue;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly crc32: number;
}

/**
 * Where the central directory lives, resolved from the EOCD (classic or
 * ZIP64). `offset`/`size` bound the bytes to range-GET; `entryCount` is a
 * sanity bound for the parser.
 */
export interface CentralDirectoryLocation {
  readonly offset: number;
  readonly size: number;
  readonly entryCount: number;
}

/**
 * Pure, IO-free ZIP parsing. Nothing here touches the network, R2, or Effect —
 * everything operates on `Uint8Array`s the caller fetched via byte-range reads.
 * Keeping this layer pure is what makes the format logic trivially testable.
 */
export { ByteReader } from './byte-reader';
export { locateCentralDirectory, type EocdResult } from './eocd';
export { parseCentralDirectory, type ParseCentralDirectoryResult } from './central-directory';
export { computeDataOffset, type LocalDataOffsetResult } from './local-header';
export {
  planMultipartParts,
  R2_MIN_PART_BYTES,
  R2_MAX_PART_BYTES,
  R2_MAX_PARTS,
  type PartPlan,
  type PlanPartsResult,
} from './multipart-plan';
export {
  CompressionMethod,
  Signature,
  type CompressionMethodValue,
  type ZipEntry,
  type CentralDirectoryLocation,
} from './format';

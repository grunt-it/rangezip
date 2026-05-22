/**
 * builder-do.ts — resumable ZIP64 sample builder Durable Object.
 *
 * Streams a valid ZIP64 archive of synthetic entries straight into an R2
 * multipart upload, server-side on Cloudflare. Nothing touches the developer's
 * bandwidth: the only data path is DO -> R2, both inside Cloudflare's edge.
 *
 * Resumability: state is persisted to the DO's SQLite at every PART boundary.
 * Each multipart part is a fixed 90 MiB chunk (R2 requires uniform part sizes
 * except the last), so a part boundary is a clean resume point — the in-flight
 * part buffer always starts fresh from the boundary. If a single invocation
 * gets near the CPU/wall-clock budget, it persists and schedules an `alarm()`
 * to continue; the 30 GB build completes across as many invocations as needed.
 *
 * Memory: one ~1 MiB reusable filler pattern + one 90 MiB part buffer. Never
 * holds an entry, let alone the archive.
 */

import { buildPlan, type PlannedEntry } from './plan';
import { crc32, crc32Combine, crc32Update } from './crc32';
import {
  centralFileHeader,
  endRecords,
  localFileHeader,
  patchLocalZip64,
  Method,
  type EntryRecord,
} from './zip64';

const MB = 1024 * 1024;
const PART_SIZE = 90 * MB; // uniform multipart part size
const PATTERN_SIZE = 1 * MB; // reusable filler pattern
// Persist + reschedule via alarm once an invocation has run this long, to stay
// well under the Worker wall-clock budget on the big (30 GB) build.
const SOFT_TIME_BUDGET_MS = 25_000;

interface BuilderState {
  key: string;
  targetBytes: number;
  uploadId: string;
  status: 'running' | 'completing' | 'done' | 'error';
  error?: string;
  // Cursor into the plan.
  entryIndex: number; // next entry to (continue) emitting
  entryDataWritten: number; // bytes of the current entry's DATA already emitted
  emittingLocalHeader: boolean; // true => local header for entryIndex not yet emitted
  fileOffset: number; // absolute archive offset of the next byte to write
  nextPartNumber: number;
  parts: Array<{ partNumber: number; etag: string }>;
  // Central-directory records for entries fully emitted so far. Persisted so a
  // resumed invocation can rebuild the central directory at the end.
  records: EntryRecord[];
  finalSize?: number;
  fileCount?: number;
}

interface Env {
  SAMPLES: R2Bucket;
  BUILDER: DurableObjectNamespace;
}

export class SampleBuilder {
  private ctx: DurableObjectState;
  private env: Env;
  private pattern: Uint8Array;
  private patternCrc: number;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    // Deterministic, incompressible-looking pattern (LCG). One buffer, reused.
    this.pattern = new Uint8Array(PATTERN_SIZE);
    let s = 0x9e3779b9 >>> 0;
    for (let i = 0; i < this.pattern.length; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      this.pattern[i] = s & 0xff;
    }
    this.patternCrc = crc32(this.pattern);
  }

  private loadState(): BuilderState | null {
    const v = this.ctx.storage.kv.get('state') as string | undefined;
    return v ? (JSON.parse(v) as BuilderState) : null;
  }

  private saveState(state: BuilderState): void {
    this.ctx.storage.kv.put('state', JSON.stringify(state));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    if (action === 'start') {
      const key = url.searchParams.get('key')!;
      const targetBytes = Number(url.searchParams.get('target'));
      const existing = this.loadState();
      if (existing && existing.status !== 'error') {
        return Response.json({ message: 'already running/done', state: this.summary(existing) });
      }
      const mpu = await this.env.SAMPLES.createMultipartUpload(key);
      const state: BuilderState = {
        key,
        targetBytes,
        uploadId: mpu.uploadId,
        status: 'running',
        entryIndex: 0,
        entryDataWritten: 0,
        emittingLocalHeader: true,
        fileOffset: 0,
        nextPartNumber: 1,
        parts: [],
        records: [],
      };
      this.saveState(state);
      // Kick the build loop in the background; it persists + alarms as needed.
      this.ctx.waitUntil(this.runUntilBudget());
      return Response.json({ message: 'started', uploadId: mpu.uploadId });
    }

    if (action === 'status') {
      const state = this.loadState();
      return Response.json(state ? this.summary(state) : { status: 'none' });
    }

    if (action === 'abort') {
      const state = this.loadState();
      if (state) {
        try {
          await this.env.SAMPLES.resumeMultipartUpload(state.key, state.uploadId).abort();
        } catch {
          /* best effort */
        }
        this.ctx.storage.kv.delete('state');
        await this.ctx.storage.deleteAlarm();
      }
      return Response.json({ message: 'aborted' });
    }

    return new Response('unknown action', { status: 400 });
  }

  async alarm(): Promise<void> {
    await this.runUntilBudget();
  }

  private summary(state: BuilderState) {
    return {
      status: state.status,
      key: state.key,
      targetBytes: state.targetBytes,
      bytesWritten: state.fileOffset,
      partsUploaded: state.parts.length,
      entriesEmitted: state.entryIndex,
      finalSize: state.finalSize,
      fileCount: state.fileCount,
      error: state.error,
    };
  }

  /**
   * Generate + upload parts until either the archive is finished or the soft
   * time budget is reached; in the latter case persist and schedule an alarm to
   * continue. State is only persisted at part boundaries, which are clean
   * resume points (parts are independent fixed-size chunks).
   */
  private async runUntilBudget(): Promise<void> {
    const state = this.loadState();
    if (!state || state.status === 'done' || state.status === 'error') return;

    const startedAt = Date.now();
    const plan = buildPlan(state.targetBytes);
    const upload = this.env.SAMPLES.resumeMultipartUpload(state.key, state.uploadId);

    // Snapshot of all PERSISTED progress as of this invocation's entry into the
    // loop. R2 requires uniform part sizes (except the last), so we may ONLY
    // persist + yield when the in-flight buffer is empty (a full-part boundary).
    // At that instant every appended byte — and thus every advanced
    // entryIndex / pushed record / fileOffset increment — is already uploaded,
    // so the persisted state is exactly consistent with the uploaded parts.
    // Partial parts are NEVER uploaded mid-build.
    const YIELD = Symbol('yield');

    try {
      const part = new Uint8Array(PART_SIZE);
      let partLen = 0;
      let yieldRequested = false;

      const uploadCurrentPart = async (): Promise<void> => {
        const body = part.subarray(0, partLen);
        const uploaded = await upload.uploadPart(state.nextPartNumber, body.slice());
        state.parts.push({ partNumber: state.nextPartNumber, etag: uploaded.etag });
        state.nextPartNumber++;
        partLen = 0;
      };

      const uploadCurrentPartAndMaybeYield = async (countTowardEntry: number): Promise<void> => {
        await uploadCurrentPart();
        // Buffer is now empty — a clean full-part boundary. If a yield was
        // requested and there's still data to emit, persist FULLY-consistent
        // state (every buffered byte, including the current entry's progress, is
        // uploaded) and schedule an alarm to resume. `countTowardEntry` is the
        // bytes of the current entry's DATA that have just been flushed; the
        // caller has already folded these into state.entryDataWritten BEFORE we
        // reach a flush, so state is exact at this point.
        void countTowardEntry;
        if (yieldRequested && state.entryIndex < plan.length) {
          this.saveState(state);
          await this.ctx.storage.setAlarm(Date.now() + 50);
          throw YIELD;
        }
      };

      // Append STRUCTURAL bytes (local header, central directory, end records).
      // Small and not part of an entry's resumable data cursor.
      const append = async (src: Uint8Array): Promise<void> => {
        let off = 0;
        while (off < src.length) {
          const space = PART_SIZE - partLen;
          const n = Math.min(space, src.length - off);
          part.set(src.subarray(off, off + n), partLen);
          partLen += n;
          off += n;
          state.fileOffset += n;
          if (partLen === PART_SIZE) await uploadCurrentPartAndMaybeYield(0);
        }
      };

      // Append ENTRY DATA bytes, folding each consumed byte into
      // state.entryDataWritten BEFORE any flush/yield, so a yield mid-entry
      // leaves entryDataWritten exactly at the uploaded boundary. On resume the
      // entry continues from there with no gap and no duplication.
      const appendData = async (src: Uint8Array): Promise<void> => {
        let off = 0;
        while (off < src.length) {
          const space = PART_SIZE - partLen;
          const n = Math.min(space, src.length - off);
          part.set(src.subarray(off, off + n), partLen);
          partLen += n;
          off += n;
          state.fileOffset += n;
          state.entryDataWritten += n; // fold in BEFORE the possible flush/yield
          if (partLen === PART_SIZE) await uploadCurrentPartAndMaybeYield(n);
        }
      };

      // ----- emit entry data (local header + data) -----
      while (state.entryIndex < plan.length) {
        const entry = plan[state.entryIndex]!;

        if (state.emittingLocalHeader) {
          const headerOffset = state.fileOffset;
          const header = localFileHeader(entry.name, entry.method, 0);
          // rangezip reads sizes from the central directory (not the local CRC),
          // and STORED sizes are known up front, so we stamp them here.
          const { crc, compressedSize } = this.entrySizes(entry);
          new DataView(header.buffer).setUint32(14, crc >>> 0, true); // crc-32 slot
          patchLocalZip64(header, entry.name, entry.uncompressedSize, compressedSize);
          await append(header);

          state.records.push({
            name: entry.name,
            method: entry.method,
            crc32: crc,
            compressedSize,
            uncompressedSize: entry.uncompressedSize,
            localHeaderOffset: headerOffset,
          });
          state.emittingLocalHeader = false;
          state.entryDataWritten = 0;
        }

        // Stream this entry's data (resumes from entryDataWritten if mid-entry).
        await this.emitEntryData(entry, state, appendData);

        // Entry done.
        state.entryIndex++;
        state.emittingLocalHeader = true;
        state.entryDataWritten = 0;

        // Request a yield once over budget; the actual persist+alarm happens at
        // the next FULL-part boundary inside appendData, never on a partial part.
        if (Date.now() - startedAt > SOFT_TIME_BUDGET_MS) yieldRequested = true;
      }

      // ----- all entries emitted: append central directory + end records -----
      state.status = 'completing';
      const cdOffset = state.fileOffset;
      let cdSize = 0;
      for (const rec of state.records) {
        const cd = centralFileHeader(rec);
        cdSize += cd.length;
        await append(cd);
      }
      const eocd64FileOffset = cdOffset + cdSize;
      const end = endRecords(state.records.length, cdSize, cdOffset, eocd64FileOffset);
      await append(end);

      // Flush the final part (may be smaller than PART_SIZE — that's allowed
      // for the LAST part only).
      if (partLen > 0) await uploadCurrentPart();

      // Complete the multipart upload.
      const obj = await upload.complete(state.parts);
      state.status = 'done';
      state.finalSize = state.fileOffset;
      state.fileCount = state.records.length;
      this.saveState(state);
      void obj;
    } catch (err) {
      if (err === YIELD) return; // cooperative yield — alarm will resume
      state.status = 'error';
      state.error = err instanceof Error ? err.message : String(err);
      this.saveState(state);
    }
  }

  /** Compute (crc, compressedSize) for an entry without streaming its data. */
  private entrySizes(entry: PlannedEntry): { crc: number; compressedSize: number } {
    if (entry.method === Method.STORED) {
      // CRC of N full patterns + a tail remainder, via crc32_combine.
      const full = Math.floor(entry.uncompressedSize / PATTERN_SIZE);
      const tail = entry.uncompressedSize - full * PATTERN_SIZE;
      let crc = 0;
      if (full > 0) {
        crc = this.patternCrc;
        // combine the pattern crc with itself (full-1) more times
        for (let i = 1; i < full; i++) crc = crc32Combine(crc, this.patternCrc, PATTERN_SIZE);
      }
      if (tail > 0) {
        const tailCrc = crc32(this.pattern.subarray(0, tail));
        crc = full > 0 ? crc32Combine(crc, tailCrc, tail) : tailCrc;
      }
      return { crc, compressedSize: entry.uncompressedSize };
    }
    // DEFLATE text: tiny — compute exact compressed bytes + crc once here.
    const data = this.textBytes(entry);
    const crc = crc32(data);
    const compressed = this.deflateRaw(data);
    // cache compressed length on the entry via a side map keyed by name
    this.deflateCache.set(entry.name, compressed);
    return { crc, compressedSize: compressed.length };
  }

  private deflateCache = new Map<string, Uint8Array>();

  /** Stream the entry's data bytes through `append`. */
  private async emitEntryData(
    entry: PlannedEntry,
    state: BuilderState,
    appendData: (src: Uint8Array) => Promise<void>,
  ): Promise<void> {
    // `appendData` folds each consumed byte into state.entryDataWritten itself,
    // so this method computes how much of THIS entry is still outstanding and
    // streams exactly that, resuming cleanly from a mid-entry yield.
    if (entry.method === Method.STORED) {
      let remaining = entry.uncompressedSize - state.entryDataWritten;
      while (remaining > 0) {
        const n = Math.min(remaining, PATTERN_SIZE);
        await appendData(this.pattern.subarray(0, n));
        remaining -= n;
      }
    } else {
      const compressed =
        this.deflateCache.get(entry.name) ?? this.deflateRaw(this.textBytes(entry));
      // DEFLATE entries are tiny (well under a part); emit the remainder from
      // the resume cursor.
      const already = state.entryDataWritten;
      if (already < compressed.length) await appendData(compressed.subarray(already));
    }
  }

  private textBytes(entry: PlannedEntry): Uint8Array {
    // ASCII-only so 1 char == 1 byte: the slice below must be byte-exact to
    // match the entry's declared uncompressedSize (a multi-byte char like an
    // em-dash would make encode() produce MORE bytes than uncompressedSize,
    // breaking the declared size — caught in verify against the parser).
    const line = `rangezip sample ${entry.name} -- repeated compressible line of text. `;
    let out = '';
    while (out.length < entry.uncompressedSize) out += line;
    const bytes = new TextEncoder().encode(out);
    return bytes.subarray(0, entry.uncompressedSize);
  }

  /** Synchronous raw-DEFLATE via a small fixed-block encoder (stored-block fallback). */
  private deflateRaw(data: Uint8Array): Uint8Array {
    // Use the platform CompressionStream is async; for these tiny text files we
    // instead emit raw-DEFLATE "stored" blocks (type 00). This is valid DEFLATE
    // that rangezip inflates with DecompressionStream('deflate-raw'). It does
    // not shrink, but it correctly exercises the inflate path and keeps this
    // method synchronous and cheap.
    const MAXBLK = 0xffff;
    const blocks: Uint8Array[] = [];
    let off = 0;
    do {
      const n = Math.min(MAXBLK, data.length - off);
      const isLast = off + n >= data.length;
      const hdr = new Uint8Array(5);
      hdr[0] = isLast ? 1 : 0; // BFINAL in bit0, BTYPE=00
      hdr[1] = n & 0xff;
      hdr[2] = (n >>> 8) & 0xff;
      hdr[3] = ~n & 0xff;
      hdr[4] = (~n >>> 8) & 0xff;
      blocks.push(hdr, data.subarray(off, off + n));
      off += n;
    } while (off < data.length);
    if (data.length === 0) {
      return new Uint8Array([1, 0, 0, 0xff, 0xff]);
    }
    let total = 0;
    for (const b of blocks) total += b.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const b of blocks) {
      out.set(b, p);
      p += b.length;
    }
    return out;
  }
}

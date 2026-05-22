/**
 * plan.ts — deterministic entry plan for a target archive size.
 *
 * Mirrors the live 2 GB sample's folder mix (images/ · video/ · docs/ · text/)
 * but with cheap synthetic content so it can be generated on a Worker:
 *   - "media" entries (images/, video/) are large STORED filler (~15–25 MB),
 *     mostly incompressible-looking repeated pattern bytes; STORED means zero
 *     compression CPU and an honest on-disk size.
 *   - "text"/"docs" entries are small DEFLATE text files — exercise the inflate
 *     path on the rangezip side.
 *
 * The plan is a flat, ordered list. It is deterministic given the target size,
 * so a resumed invocation regenerates the exact same plan and can skip to the
 * cursor. We over-provision media entries and stop once the running data total
 * reaches the target; the last media entry is trimmed to land near the target.
 */

import { Method, type MethodValue } from './zip64';

const MB = 1024 * 1024;

export interface PlannedEntry {
  readonly name: string;
  readonly method: MethodValue;
  /** Uncompressed data length in bytes (== compressed for STORED). */
  readonly uncompressedSize: number;
  /** STORED filler vs DEFLATE text. */
  readonly kind: 'media' | 'text';
}

/** Round-robin media sizes (bytes) so files look varied, like real media. */
const MEDIA_SIZES = [15, 18, 20, 22, 25, 17, 19, 24].map((mb) => mb * MB);

const MEDIA_FOLDERS = [
  { dir: 'images/png', ext: 'png', prefix: 'graphic' },
  { dir: 'images/jpeg', ext: 'jpg', prefix: 'photo' },
  { dir: 'video', ext: 'mp4', prefix: 'clip' },
] as const;

const TEXT_FOLDERS = [
  { dir: 'text/plain', ext: 'txt', prefix: 'note' },
  { dir: 'text/markdown', ext: 'md', prefix: 'doc' },
  { dir: 'text/data', ext: 'csv', prefix: 'table' },
  { dir: 'docs', ext: 'pdf', prefix: 'report' },
] as const;

/** Small DEFLATE text entry uncompressed size (varied). */
const TEXT_SIZES = [48, 96, 160, 64, 200, 32].map((kb) => kb * 1024);

/**
 * Build the full plan for a target archive size (in bytes). Roughly 1 small
 * text/doc entry per ~12 media entries, so the file count is dominated by media
 * but there's a meaningful spread of small DEFLATE entries (and a populated
 * central directory) — matching the 2 GB sample's character.
 *
 * Note `targetBytes` targets the DATA total; header + central-directory overhead
 * adds a small amount on top (a few MB at most), which is fine for a "~10 GB"
 * sample label. We compute the REAL final size after generation regardless.
 */
export function buildPlan(targetBytes: number): PlannedEntry[] {
  const plan: PlannedEntry[] = [];
  let dataTotal = 0;
  let mediaIdx = 0;
  let textIdx = 0;

  while (dataTotal < targetBytes) {
    // Emit one text entry every 12 media entries.
    if (mediaIdx > 0 && mediaIdx % 12 === 0 && dataTotal < targetBytes) {
      const tf = TEXT_FOLDERS[textIdx % TEXT_FOLDERS.length]!;
      const size = TEXT_SIZES[textIdx % TEXT_SIZES.length]!;
      plan.push({
        name: `${tf.dir}/${tf.prefix}-${String(textIdx).padStart(6, '0')}.${tf.ext}`,
        method: Method.DEFLATE,
        uncompressedSize: size,
        kind: 'text',
      });
      // text entries are tiny and DEFLATE-compress; count their compressed
      // footprint as ~0 against the target so media drives the size honestly.
      textIdx++;
    }

    const mf = MEDIA_FOLDERS[mediaIdx % MEDIA_FOLDERS.length]!;
    let size = MEDIA_SIZES[mediaIdx % MEDIA_SIZES.length]!;

    const remaining = targetBytes - dataTotal;
    if (remaining < size) {
      // Trim the final media entry so we land just at/above the target. Keep a
      // sane floor so the last file is still a "real" media-sized object.
      size = Math.max(remaining, MB);
    }

    plan.push({
      name: `${mf.dir}/${mf.prefix}-${String(mediaIdx).padStart(6, '0')}.${mf.ext}`,
      method: Method.STORED,
      uncompressedSize: size,
      kind: 'media',
    });
    dataTotal += size;
    mediaIdx++;
  }

  return plan;
}

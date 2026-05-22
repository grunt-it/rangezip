/**
 * make-sample-rich.ts — generate a realistic, mixed-content ~2 GB sample ZIP.
 *
 * Content breakdown (targeting ~2 GB on-disk ZIP):
 *   images/png/   — large plasma PNG files via ImageMagick (~20 MB each)
 *   images/jpeg/  — plasma JPEG files via ImageMagick (~1–4 MB each)
 *   text/         — .txt .md .csv .json via fflate DEFLATE
 *   docs/         — PDFs via pdf-lib
 *   video/        — mp4 clips via ffmpeg testsrc (~10–25 MB each)
 *
 * ZIP entries: STORED for pre-compressed formats (PNG, JPEG, PDF, MP4),
 *              DEFLATE for text/data files.
 *
 * Memory discipline: each image/video is generated as a temp file, read once
 * into a buffer, piped into fflate streaming ZIP, then the temp file is deleted.
 * Text/data is generated in-process. At no point is more than one file's worth
 * of data in memory simultaneously.
 *
 * Run:
 *   bun run scripts/make-sample-rich.ts [--out ./samples/sample-2gb.zip]
 */

import { createWriteStream } from 'node:fs';
import { mkdir, stat, unlink, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;
const KB = 1024;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const rawArgs = process.argv.slice(2);
const outArg = rawArgs.indexOf('--out');
const OUT = outArg >= 0 ? rawArgs[outArg + 1]! : './samples/sample-2gb.zip';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function fmtBytes(n: number): string {
  if (n >= GB) return (n / GB).toFixed(3) + ' GB';
  if (n >= MB) return (n / MB).toFixed(1) + ' MB';
  return (n / KB).toFixed(0) + ' KB';
}

// ---------------------------------------------------------------------------
// Image generation via ImageMagick CLI
// ---------------------------------------------------------------------------
type ImageSpec = {
  zipPath: string;
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  quality?: number;
  pattern: 'plasma' | 'gradient' | 'radial-gradient';
};

function generateImageFile(spec: ImageSpec, tmpPath: string): boolean {
  const args: string[] = ['-size', `${spec.width}x${spec.height}`];

  if (spec.pattern === 'gradient') {
    // gradient: from one color to another
    args.push(`gradient:navy-gold`);
  } else if (spec.pattern === 'radial-gradient') {
    args.push(`radial-gradient:white-blue`);
  } else {
    // plasma: colorful noise-like pattern
    args.push('plasma:');
  }

  if (spec.format === 'jpeg' && spec.quality) {
    args.push('-quality', String(spec.quality));
  }

  args.push(tmpPath);

  const result = spawnSync('magick', args, { stdio: 'pipe' });
  if (result.status !== 0) {
    console.error(`  magick failed:`, result.stderr?.toString().slice(0, 200));
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Video generation via ffmpeg
// ---------------------------------------------------------------------------
function generateVideoFile(index: number, durationSecs: number, tmpPath: string): boolean {
  const patterns = ['testsrc', 'testsrc2', 'rgbtestsrc', 'smptebars', 'smptehdbars'];
  const pattern = patterns[index % patterns.length]!;
  const size = index % 2 === 0 ? '1280x720' : '960x540';
  const result = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `${pattern}=duration=${durationSecs}:size=${size}:rate=25`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'ultrafast',
      '-crf',
      '25',
      tmpPath,
    ],
    { stdio: 'pipe' },
  );
  if (result.status !== 0) {
    console.error(`  ffmpeg failed for video ${index}:`, result.stderr?.toString().slice(-300));
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Text content generation
// ---------------------------------------------------------------------------
const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor ' +
  'incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud ' +
  'exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure ' +
  'dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. ' +
  'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt ' +
  'mollit anim id est laborum. ';

function generateTxt(index: number, targetBytes: number): Uint8Array {
  let content = `# File ${index} — rangezip sample\n\nGenerated synthetic text file.\n\n`;
  while (content.length < targetBytes) content += LOREM;
  return new TextEncoder().encode(content.slice(0, targetBytes));
}

function generateMd(index: number, targetBytes: number): Uint8Array {
  let content = `# Document ${index}\n\n## Overview\n\nSynthetic rangezip sample.\n\n## Content\n\n`;
  while (content.length < targetBytes) {
    content += `- Item ${content.length}: ${LOREM.slice(0, 80)}\n`;
  }
  return new TextEncoder().encode(content.slice(0, targetBytes));
}

function generateCsv(index: number, rows: number): Uint8Array {
  const cols = ['id', 'name', 'value', 'category', 'timestamp', 'active', 'score'];
  let csv = cols.join(',') + '\n';
  for (let r = 0; r < rows; r++) {
    csv +=
      [
        r + 1,
        `item_${index}_${r}`,
        ((r * 7 + index * 13) % 10000) / 100,
        `cat_${r % 8}`,
        new Date(1700000000000 + r * 3600000).toISOString(),
        r % 2 === 0,
        (r * 3 + index * 7) % 100,
      ].join(',') + '\n';
  }
  return new TextEncoder().encode(csv);
}

function generateJson(index: number, items: number): Uint8Array {
  const records: Record<string, unknown>[] = [];
  for (let i = 0; i < items; i++) {
    records.push({
      id: `${index}-${i}`,
      title: `Record ${i} in dataset ${index}`,
      description: LOREM.slice(0, 120),
      tags: [`tag${i % 5}`, `category${i % 3}`],
      metadata: {
        created: new Date(1700000000000 + i * 86400000).toISOString(),
        version: i % 4,
        active: i % 3 !== 0,
      },
      value: ((i * 17 + index * 31) % 99999) / 100,
    });
  }
  return new TextEncoder().encode(JSON.stringify({ dataset: index, records }, null, 2));
}

// ---------------------------------------------------------------------------
// PDF generation via pdf-lib
// ---------------------------------------------------------------------------
async function generatePdf(index: number, pages: number): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  for (let p = 0; p < pages; p++) {
    const page = pdfDoc.addPage([612, 792]);
    const { width, height } = page.getSize();

    page.drawText(`Report ${index} — Page ${p + 1} of ${pages}`, {
      x: 50,
      y: height - 80,
      size: 18,
      font: boldFont,
      color: rgb(0.1, 0.1, 0.5),
    });

    let y = height - 130;
    const bodyText = LOREM.repeat(4).slice(0, 600 + p * 40);
    const words = bodyText.split(' ');
    let line = '';
    for (const word of words) {
      const candidate = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(candidate, 11) > width - 100 && line) {
        if (y < 80) break;
        page.drawText(line, { x: 50, y, size: 11, font, color: rgb(0.1, 0.1, 0.1) });
        y -= 16;
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line && y >= 80) {
      page.drawText(line, { x: 50, y, size: 11, font, color: rgb(0.1, 0.1, 0.1) });
    }

    page.drawText(`rangezip-sample | report-${String(index).padStart(3, '0')}.pdf`, {
      x: 50,
      y: 40,
      size: 9,
      font,
      color: rgb(0.5, 0.5, 0.5),
    });
  }

  return pdfDoc.save();
}

// ---------------------------------------------------------------------------
// ZIP streaming helper — push data in 1 MiB chunks with backpressure
// ---------------------------------------------------------------------------
async function pushBuffer(
  entry: ZipDeflate | ZipPassThrough,
  data: Uint8Array,
  fileStream: import('node:fs').WriteStream,
): Promise<void> {
  const CHUNK = 1024 * 1024;
  let offset = 0;
  while (offset < data.length) {
    const end = Math.min(offset + CHUNK, data.length);
    const slice = data.subarray(offset, end);
    entry.push(slice as Uint8Array, end >= data.length);
    offset = end;
    if (fileStream.writableNeedDrain) await once(fileStream, 'drain');
  }
}

// ---------------------------------------------------------------------------
// Plan structure
// ---------------------------------------------------------------------------
interface PlanEntry {
  zipPath: string;
  compressionLevel: 0 | 6;
  generate(): Promise<{ data: Uint8Array; tmpFile?: string }>;
}

// ---------------------------------------------------------------------------
// Build plan targeting ~2 GB on-disk ZIP
// ---------------------------------------------------------------------------
function buildPlan(): PlanEntry[] {
  const plan: PlanEntry[] = [];
  const tmp = tmpdir();

  // ==========================================================================
  // IMAGES — target ~1.85 GB total
  // ==========================================================================
  // IMPORTANT: Only plasma pattern produces large files.
  //   plasma PNG 2048x2048 → ~20 MB
  //   plasma PNG 3000x3000 → ~44 MB
  //   plasma PNG 2000x2000 → ~22 MB
  //   plasma JPEG 3000x2000 q=95 → ~3 MB
  //   gradient / radial-gradient compress to near-nothing — do NOT use.
  //
  // Strategy: 90 plasma PNGs (mix of sizes) → ~1.75 GB
  //           60 plasma JPEGs (varied) → ~150 MB

  const pngSpecs = [
    { w: 2048, h: 2048 }, // ~20 MB
    { w: 2000, h: 2000 }, // ~22 MB
    { w: 2400, h: 2000 }, // ~27 MB
    { w: 2048, h: 1700 }, // ~19 MB
    { w: 1800, h: 1800 }, // ~18 MB
  ];
  for (let i = 0; i < 90; i++) {
    const sz = pngSpecs[i % pngSpecs.length]!;
    const tmpFile = join(tmp, `rz-png-${i}-${Date.now()}.png`);
    plan.push({
      zipPath: `images/png/graphic-${String(i).padStart(4, '0')}.png`,
      compressionLevel: 0,
      generate: async () => {
        const ok = generateImageFile(
          { zipPath: '', format: 'png', width: sz.w, height: sz.h, pattern: 'plasma' },
          tmpFile,
        );
        if (!ok) throw new Error(`magick PNG ${i} failed`);
        const data = new Uint8Array((await readFile(tmpFile)).buffer);
        return { data, tmpFile };
      },
    });
  }

  // 60 JPEG plasma images — ~1–5 MB each → ~150 MB total
  const jpegSpecs = [
    { w: 3000, h: 2000, q: 95 }, // ~3 MB
    { w: 4000, h: 3000, q: 92 }, // ~3.5 MB
    { w: 1920, h: 1080, q: 95 }, // ~0.7 MB
    { w: 2560, h: 1440, q: 92 }, // ~1.6 MB
    { w: 3840, h: 2160, q: 90 }, // ~4 MB
    { w: 2048, h: 1536, q: 92 }, // ~1.5 MB
  ];
  for (let i = 0; i < 60; i++) {
    const sz = jpegSpecs[i % jpegSpecs.length]!;
    const tmpFile = join(tmp, `rz-jpg-${i}-${Date.now()}.jpg`);
    plan.push({
      zipPath: `images/jpeg/photo-${String(i).padStart(4, '0')}.jpg`,
      compressionLevel: 0,
      generate: async () => {
        const ok = generateImageFile(
          {
            zipPath: '',
            format: 'jpeg',
            width: sz.w,
            height: sz.h,
            quality: sz.q,
            pattern: 'plasma',
          },
          tmpFile,
        );
        if (!ok) throw new Error(`magick JPEG ${i} failed`);
        const data = new Uint8Array((await readFile(tmpFile)).buffer);
        return { data, tmpFile };
      },
    });
  }

  // ==========================================================================
  // TEXT — target ~100 MB on disk (DEFLATE, text compresses ~10:1)
  // ==========================================================================
  // 150 .txt, 80 .md, 60 .csv, 40 .json

  for (let i = 0; i < 150; i++) {
    const targetBytes = (1024 + (i % 20) * 200) * KB; // 1–5 MB uncompressed → ~100–500 KB compressed
    plan.push({
      zipPath: `text/plain/note-${String(i).padStart(4, '0')}.txt`,
      compressionLevel: 6,
      generate: async () => ({ data: generateTxt(i, targetBytes) }),
    });
  }

  for (let i = 0; i < 80; i++) {
    const targetBytes = (512 + (i % 10) * 150) * KB;
    plan.push({
      zipPath: `text/markdown/doc-${String(i).padStart(4, '0')}.md`,
      compressionLevel: 6,
      generate: async () => ({ data: generateMd(i, targetBytes) }),
    });
  }

  for (let i = 0; i < 60; i++) {
    plan.push({
      zipPath: `text/data/table-${String(i).padStart(4, '0')}.csv`,
      compressionLevel: 6,
      generate: async () => ({ data: generateCsv(i, 1000 + i * 240) }),
    });
  }

  for (let i = 0; i < 40; i++) {
    plan.push({
      zipPath: `text/data/dataset-${String(i).padStart(4, '0')}.json`,
      compressionLevel: 6,
      generate: async () => ({ data: generateJson(i, 500 + i * 75) }),
    });
  }

  // ==========================================================================
  // PDFs — ~20 files, small
  // ==========================================================================
  for (let i = 0; i < 20; i++) {
    plan.push({
      zipPath: `docs/report-${String(i).padStart(3, '0')}.pdf`,
      compressionLevel: 0,
      generate: async () => ({ data: await generatePdf(i, 5 + (i % 16)) }),
    });
  }

  // ==========================================================================
  // VIDEO — 10 clips, ~10–25 MB each → ~150 MB
  // ==========================================================================
  for (let i = 0; i < 10; i++) {
    const duration = 15 + i * 3; // 15, 18, ..., 42 s
    const tmpFile = join(tmp, `rz-video-${i}-${Date.now()}.mp4`);
    plan.push({
      zipPath: `video/clip-${String(i).padStart(2, '0')}.mp4`,
      compressionLevel: 0,
      generate: async () => {
        const ok = generateVideoFile(i, duration, tmpFile);
        if (!ok) throw new Error(`ffmpeg video ${i} failed`);
        const data = new Uint8Array((await readFile(tmpFile)).buffer);
        return { data, tmpFile };
      },
    });
  }

  return plan;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('make-sample-rich.ts — generating realistic mixed-content ~2 GB ZIP\n');

  const plan = buildPlan();

  const kindCounts: Record<string, number> = {};
  for (const e of plan) {
    const kind = e.zipPath.split('/').slice(0, 2).join('/');
    kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
  }
  console.log('Plan:');
  for (const [k, v] of Object.entries(kindCounts)) {
    console.log(`  ${k.padEnd(22)} ${v} files`);
  }
  console.log(`  ${'TOTAL'.padEnd(22)} ${plan.length} files`);
  console.log(`\nOutput: ${OUT}\n`);

  await mkdir(dirname(OUT), { recursive: true });

  let zipError: Error | null = null;
  let bytesWritten = 0;
  let ended = false;
  let filesDone = 0;
  let filesSkipped = 0;

  const fileStream = createWriteStream(OUT);

  const zip = new Zip((err, chunk, final) => {
    if (err) {
      zipError = err;
      return;
    }
    bytesWritten += chunk.length;
    fileStream.write(chunk);
    if (final) {
      ended = true;
      fileStream.end();
    }
  });

  const startTime = Date.now();

  for (const entry of plan) {
    if (zipError) throw zipError;

    let data: Uint8Array;
    let tmpFile: string | undefined;

    try {
      const result = await entry.generate();
      data = result.data;
      tmpFile = result.tmpFile;
    } catch (err) {
      console.log(`\n  SKIP ${entry.zipPath}: ${err instanceof Error ? err.message : String(err)}`);
      filesSkipped++;
      filesDone++;
      continue;
    }

    if (entry.compressionLevel === 0) {
      const ze = new ZipPassThrough(entry.zipPath);
      zip.add(ze);
      await pushBuffer(ze, data, fileStream);
    } else {
      const ze = new ZipDeflate(entry.zipPath, { level: entry.compressionLevel });
      zip.add(ze);
      await pushBuffer(ze, data, fileStream);
    }

    // Delete temp file immediately to free disk space
    if (tmpFile) {
      try {
        await unlink(tmpFile);
      } catch {
        /* ignore */
      }
    }

    filesDone++;

    if (filesDone % 5 === 0 || filesDone === plan.length) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = bytesWritten / elapsed;
      process.stdout.write(
        `  [${String(filesDone).padStart(4)}/${plan.length}] ` +
          `${fmtBytes(bytesWritten).padEnd(10)} ` +
          `${(rate / MB).toFixed(1)} MB/s — ${entry.zipPath.slice(0, 50)}      \r`,
      );
    }
  }

  zip.end();

  while (!ended) await new Promise((r) => setTimeout(r, 20));
  await once(fileStream, 'close');
  if (zipError) throw zipError;

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const finalStat = await stat(OUT);

  console.log(`\n`);
  console.log(`Done in ${elapsed}s.`);
  console.log(`  ZIP size: ${fmtBytes(finalStat.size)} (${finalStat.size} bytes)`);
  console.log(`  Files:    ${filesDone - filesSkipped} archived, ${filesSkipped} skipped`);
  console.log(`  Output:   ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * make-sample.ts — generate a synthetic, many-file ZIP of a target size and
 * (optionally) upload it to the demo R2 bucket. Run with `bun`.
 *
 *   bun run scripts/make-sample.ts --size 2gb --out ./samples/rangezip-sample-2gb.zip
 *   bun run scripts/make-sample.ts --size 2gb --upload                # uploads via wrangler
 *
 * Why a script, not a fixture: the demo's headline (range bytes vs archive
 * size) only impresses on a *large* archive with *many* entries — a meaningful
 * central directory + per-file extraction. This produces exactly that: thousands
 * of small-to-medium files, a deliberate MIX of STORED and DEFLATE entries, of a
 * target on-disk size (2 / 10 / 30 GB).
 *
 * Memory discipline (same spirit as the Worker): the ZIP is generated with
 * `fflate`'s STREAMING `Zip` API and piped chunk-by-chunk to a file write stream
 * with backpressure — the whole archive is NEVER buffered in memory, so a 30 GB
 * sample generates in bounded RAM.
 *
 * Uploading 10/30 GB is a one-time manual step on Nik's machine; `--upload`
 * shells out to `wrangler r2 object put`. If you skip it, the file is written
 * locally and you upload it however you like, then set the public URL + flip
 * `available` in `src/samples.ts` (see README "Sample data").
 */

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';

const GB = 1024 * 1024 * 1024;

interface SizeSpec {
  readonly label: string;
  readonly targetBytes: number;
  readonly fileCount: number;
  readonly defaultOut: string;
  readonly defaultKey: string;
}

/** The three presets, matching `src/samples.ts`. */
const SIZES: Record<string, SizeSpec> = {
  '2gb': {
    label: '2 GB',
    targetBytes: 2 * GB,
    fileCount: 2000,
    defaultOut: './samples/rangezip-sample-2gb.zip',
    defaultKey: 'samples/rangezip-sample-2gb.zip',
  },
  '10gb': {
    label: '10 GB',
    targetBytes: 10 * GB,
    fileCount: 10000,
    defaultOut: './samples/rangezip-sample-10gb.zip',
    defaultKey: 'samples/rangezip-sample-10gb.zip',
  },
  '30gb': {
    label: '30 GB',
    targetBytes: 30 * GB,
    fileCount: 30000,
    defaultOut: './samples/rangezip-sample-30gb.zip',
    defaultKey: 'samples/rangezip-sample-30gb.zip',
  },
};

/** The R2 bucket name to upload to (matches wrangler.jsonc). */
const BUCKET = 'rangezip-output';

// -------------------------------------------------------------------------------------------------
// Args
// -------------------------------------------------------------------------------------------------

interface Args {
  size: string;
  out: string;
  key: string;
  upload: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const size = (get('--size') ?? '2gb').toLowerCase();
  const spec = SIZES[size];
  if (!spec) {
    console.error(`Unknown --size "${size}". Choose one of: ${Object.keys(SIZES).join(', ')}`);
    process.exit(1);
  }
  return {
    size,
    out: get('--out') ?? spec.defaultOut,
    key: get('--key') ?? spec.defaultKey,
    upload: argv.includes('--upload'),
  };
}

// -------------------------------------------------------------------------------------------------
// Content generation
// -------------------------------------------------------------------------------------------------

/**
 * Deterministic-ish pseudo-random bytes. A simple LCG so STORED entries don't
 * compress (incompressible), giving honest on-disk sizes. Reused buffer to keep
 * allocation bounded.
 */
function fillRandom(buf: Uint8Array, seed: number): number {
  let s = seed >>> 0;
  for (let i = 0; i < buf.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    buf[i] = s & 0xff;
  }
  return s;
}

const encoder = new TextEncoder();

/** Compressible text content for DEFLATE entries (so DEFLATE actually shrinks). */
function textContent(index: number, size: number): Uint8Array {
  const line = `rangezip sample file ${index} — repeated, compressible line of text. `;
  let out = '';
  while (out.length < size) out += line;
  return encoder.encode(out.slice(0, size));
}

// -------------------------------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const spec = SIZES[args.size]!;

  await mkdir(dirname(args.out), { recursive: true });
  const fileStream = createWriteStream(args.out);

  // Per-file uncompressed size so STORED entries roughly hit the target on disk.
  // ~half the files are STORED incompressible (drive the on-disk size), ~half
  // are DEFLATE text (exercise the inflate path). We size for STORED ≈ target.
  const storedCount = Math.floor(spec.fileCount / 2);
  const perStoredBytes = Math.max(4096, Math.floor(spec.targetBytes / storedCount));
  const perTextBytes = 64 * 1024; // small compressible text entries

  console.log(
    `Generating ${spec.label} sample → ${args.out}\n` +
      `  ${spec.fileCount} files (${storedCount} STORED @ ~${(perStoredBytes / 1024).toFixed(0)} KiB incompressible, ` +
      `${spec.fileCount - storedCount} DEFLATE text)\n`,
  );

  let bytesWritten = 0;
  let ended = false;
  let zipError: Error | null = null;

  const zip = new Zip((err, chunk, final) => {
    if (err) {
      zipError = err;
      return;
    }
    bytesWritten += chunk.length;
    // Backpressure: if the file stream's buffer is full, the generator loop
    // below awaits 'drain' before pushing more. Here we just write.
    fileStream.write(chunk);
    if (final) {
      ended = true;
      fileStream.end();
    }
  });

  const scratch = new Uint8Array(1024 * 1024); // 1 MiB reusable random buffer
  let seed = 0x9e3779b9;

  // Helper: push a file's content in 1 MiB chunks, awaiting drain between chunks
  // so neither the file stream nor fflate's internal buffer grows unbounded.
  const pushChunked = async (
    entry: ZipDeflate | ZipPassThrough,
    total: number,
    makeChunk: (chunkSize: number) => Uint8Array,
  ): Promise<void> => {
    let remaining = total;
    while (remaining > 0) {
      const chunkSize = Math.min(remaining, scratch.length);
      const chunk = makeChunk(chunkSize);
      remaining -= chunkSize;
      entry.push(chunk, remaining === 0);
      if (fileStream.writableNeedDrain) await once(fileStream, 'drain');
      if (zipError) throw zipError;
    }
  };

  for (let i = 0; i < spec.fileCount; i++) {
    if (i < storedCount) {
      const entry = new ZipPassThrough(`stored/file-${String(i).padStart(6, '0')}.bin`);
      zip.add(entry);
      await pushChunked(entry, perStoredBytes, (n) => {
        seed = fillRandom(scratch, seed);
        return scratch.subarray(0, n);
      });
    } else {
      const entry = new ZipDeflate(`text/file-${String(i).padStart(6, '0')}.txt`, { level: 6 });
      zip.add(entry);
      const content = textContent(i, perTextBytes);
      await pushChunked(entry, content.length, (n) => content.subarray(0, n));
    }
    if (i % 500 === 0) {
      process.stdout.write(
        `  ${i}/${spec.fileCount} files · ${(bytesWritten / GB).toFixed(2)} GB on disk\r`,
      );
    }
  }

  zip.end();

  // Wait for the file stream to finish flushing.
  while (!ended) await new Promise((r) => setTimeout(r, 10));
  await once(fileStream, 'close');
  if (zipError) throw zipError;

  console.log(`\nDone. Wrote ${(bytesWritten / GB).toFixed(3)} GB to ${args.out}`);

  if (args.upload) {
    console.log(`\nUploading to R2 bucket "${BUCKET}" as "${args.key}" via wrangler…`);
    const result = spawnSync(
      'bunx',
      ['wrangler', 'r2', 'object', 'put', `${BUCKET}/${args.key}`, '--file', args.out, '--remote'],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) {
      console.error('wrangler upload failed. Upload manually and set the URL in src/samples.ts.');
      process.exit(1);
    }
    console.log(
      `\nUploaded. Now set the public URL + flip "available: true" for "${args.size}" in src/samples.ts.\n` +
        `(The bucket must have a public r2.dev URL or a bound custom domain that honours range requests.)`,
    );
  } else {
    console.log(
      `\nNot uploaded (no --upload). Upload ${args.out} to R2/your host, then set its public,\n` +
        `range-capable URL + "available: true" for "${args.size}" in src/samples.ts.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * upload-via-worker.ts — Upload a large file to R2 via the rangezip-upload-proxy Worker.
 *
 * The Worker handles R2 multipart uploads natively (R2 has no size limit for
 * multipart uploads). We chunk the file into ~95 MB parts and upload each part.
 * The Worker's R2 binding runs inside Cloudflare's edge — no size limit there.
 *
 * Run:
 *   bun run scripts/upload-via-worker.ts --file ./samples/sample-2gb.zip --key sample-2gb.zip
 */

import { readFileSync, statSync } from 'node:fs';

const MB = 1024 * 1024;
const GB = MB * 1024;

const WORKER_URL = 'https://rangezip-upload-proxy.tehnicni.workers.dev';
const UPLOAD_SECRET = 'rz-upload-2026';
const CHUNK_SIZE = 95 * MB; // 95 MiB per part

function fmtBytes(n: number): string {
  if (n >= GB) return (n / GB).toFixed(3) + ' GB';
  if (n >= MB) return (n / MB).toFixed(1) + ' MB';
  return (n / 1024).toFixed(0) + ' KB';
}

const args = process.argv.slice(2);
const fileArg = args[args.indexOf('--file') + 1] ?? './samples/sample-2gb.zip';
const keyArg = args[args.indexOf('--key') + 1] ?? 'sample-2gb.zip';

async function main(): Promise<void> {
  const fileStat = statSync(fileArg);
  console.log(
    `Uploading: ${fileArg} (${fmtBytes(fileStat.size)}) → R2: rangezip-samples/${keyArg}`,
  );
  console.log(`Worker: ${WORKER_URL}\n`);

  const startTime = Date.now();

  // Step 1: Initiate multipart upload
  console.log('Initiating multipart upload...');
  const initResp = await fetch(`${WORKER_URL}/${keyArg}?create`, {
    method: 'PUT',
    headers: {
      'x-upload-secret': UPLOAD_SECRET,
      'Content-Type': 'application/octet-stream',
    },
  });
  if (!initResp.ok) {
    const text = await initResp.text();
    throw new Error(`Initiate multipart failed (${initResp.status}): ${text}`);
  }
  const { uploadId } = (await initResp.json()) as { uploadId: string };
  console.log(`  uploadId: ${uploadId.slice(0, 30)}...\n`);

  // Step 2: Upload parts
  const fileData = readFileSync(fileArg);
  const parts: Array<{ etag: string; partNumber: number }> = [];
  let offset = 0;
  let partNumber = 1;

  while (offset < fileData.length) {
    const end = Math.min(offset + CHUNK_SIZE, fileData.length);
    const partData = fileData.subarray(offset, end);
    const pct = ((end / fileData.length) * 100).toFixed(1);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

    process.stdout.write(
      `  Part ${String(partNumber).padStart(2)}: ${fmtBytes(partData.length).padEnd(10)} ` +
        `offset=${fmtBytes(offset).padEnd(10)} ${pct}%  [${elapsed}s]\r`,
    );

    const partResp = await fetch(
      `${WORKER_URL}/${keyArg}?uploadId=${encodeURIComponent(uploadId)}&part=${partNumber}`,
      {
        method: 'PUT',
        headers: {
          'x-upload-secret': UPLOAD_SECRET,
          'Content-Type': 'application/octet-stream',
        },
        body: partData,
      },
    );

    if (!partResp.ok) {
      const text = await partResp.text();
      throw new Error(`Part ${partNumber} failed (${partResp.status}): ${text}`);
    }

    const { etag } = (await partResp.json()) as { etag: string; partNumber: number };
    parts.push({ etag, partNumber });
    console.log(
      `  Part ${String(partNumber).padStart(2)}: ${fmtBytes(partData.length).padEnd(10)} ` +
        `etag=${etag.slice(0, 20)}...  [${elapsed}s]`,
    );

    offset = end;
    partNumber++;
  }

  // Step 3: Complete multipart upload
  console.log('\nCompleting multipart upload...');
  const completeBody = parts.map((p) => ({ etag: p.etag, partNumber: p.partNumber }));
  const completeResp = await fetch(
    `${WORKER_URL}/${keyArg}?uploadId=${encodeURIComponent(uploadId)}&complete`,
    {
      method: 'PUT',
      headers: {
        'x-upload-secret': UPLOAD_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(completeBody),
    },
  );

  if (!completeResp.ok) {
    const text = await completeResp.text();
    throw new Error(`Complete multipart failed (${completeResp.status}): ${text}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const speed = fmtBytes(fileStat.size / parseFloat(elapsed));
  console.log(`\nUpload complete in ${elapsed}s (${speed}/s)!`);
  console.log(`  ${parts.length} parts, ${fmtBytes(fileStat.size)} total`);
  console.log(`  R2 key: rangezip-samples/${keyArg}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

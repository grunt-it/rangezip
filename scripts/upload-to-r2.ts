/**
 * upload-to-r2.ts — Upload a large file to R2 using the Cloudflare API
 * with multipart support (chunks of 290 MiB each to stay under CF API limits).
 *
 * The Cloudflare API at /accounts/{id}/r2/buckets/{bucket}/objects/{key}
 * supports files up to the CF request body limit. For larger files we need
 * to split into parts and use multipart upload if supported, or fall back
 * to the S3-compatible API with proper AWS4 signing.
 *
 * Run:
 *   bun run scripts/upload-to-r2.ts --file ./samples/sample-2gb.zip --key sample-2gb.zip
 */

import { createReadStream, statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const MB = 1024 * 1024;
const GB = 1024 * MB;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ACCOUNT_ID = '7837a3ae3de099b8fa6bce234738d57c';
const BUCKET = 'rangezip-samples';

// Get the OAuth token from wrangler config
function getWranglerToken(): string {
  const config = readFileSync(
    join(process.env.HOME!, 'Library/Preferences/.wrangler/config/default.toml'),
    'utf8',
  );
  const match = config.match(/oauth_token\s*=\s*"([^"]+)"/);
  if (!match?.[1]) throw new Error('Could not find oauth_token in wrangler config');
  return match[1];
}

// ---------------------------------------------------------------------------
// CF API multipart upload
// ---------------------------------------------------------------------------
async function initiateMultipart(token: string, key: string): Promise<string> {
  // Try the CF API multipart endpoint
  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/objects/${encodeURIComponent(key)}/multipart`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ customMetadata: {} }),
    },
  );
  const data = (await resp.json()) as { success: boolean; result?: { uploadId: string } };
  if (!data.success || !data.result?.uploadId) {
    throw new Error(`Multipart initiation failed: ${JSON.stringify(data)}`);
  }
  return data.result.uploadId;
}

async function uploadPart(
  token: string,
  key: string,
  uploadId: string,
  partNumber: number,
  partData: Uint8Array,
): Promise<string> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/objects/${encodeURIComponent(key)}/multipart/${encodeURIComponent(uploadId)}/parts`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Part-Number': String(partNumber),
    },
    body: partData,
  });
  const data = (await resp.json()) as { success: boolean; result?: { etag: string } };
  if (!data.success || !data.result?.etag) {
    throw new Error(`Part ${partNumber} upload failed: ${JSON.stringify(data)}`);
  }
  return data.result.etag;
}

async function completeMultipart(
  token: string,
  key: string,
  uploadId: string,
  parts: Array<{ part_number: number; etag: string }>,
): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/objects/${encodeURIComponent(key)}/multipart/${encodeURIComponent(uploadId)}/complete`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ parts }),
  });
  const data = (await resp.json()) as { success: boolean };
  if (!data.success) {
    throw new Error(`Multipart completion failed: ${JSON.stringify(data)}`);
  }
}

// ---------------------------------------------------------------------------
// Direct CF API upload (single PUT, for smaller files or parts)
// ---------------------------------------------------------------------------
async function directPut(token: string, key: string, fileData: Uint8Array): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/objects/${encodeURIComponent(key)}`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/zip',
    },
    body: fileData,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Direct PUT failed (${resp.status}): ${text.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fileArg = args[args.indexOf('--file') + 1] ?? './samples/sample-2gb.zip';
  const keyArg = args[args.indexOf('--key') + 1] ?? 'sample-2gb.zip';

  const fileStat = statSync(fileArg);
  const fileSizeGB = (fileStat.size / GB).toFixed(3);
  console.log(`Uploading: ${fileArg} (${fileSizeGB} GB) → R2: ${BUCKET}/${keyArg}\n`);

  const token = getWranglerToken();

  // Strategy: Try multipart upload first, fall back to direct PUT for each chunk
  const CHUNK_SIZE = 280 * MB; // 280 MiB per part (below wrangler's 300 MiB limit per request)

  if (fileStat.size > CHUNK_SIZE) {
    console.log(`File > ${CHUNK_SIZE / MB} MiB, attempting multipart upload via CF API...`);

    try {
      const uploadId = await initiateMultipart(token, keyArg);
      console.log(`Multipart upload initiated, uploadId: ${uploadId.slice(0, 20)}...`);

      // Read and upload parts
      const fileData = readFileSync(fileArg);
      const parts: Array<{ part_number: number; etag: string }> = [];
      let offset = 0;
      let partNumber = 1;

      while (offset < fileData.length) {
        const end = Math.min(offset + CHUNK_SIZE, fileData.length);
        const partData = new Uint8Array(fileData.buffer, offset, end - offset);
        const pct = ((end / fileData.length) * 100).toFixed(1);
        process.stdout.write(
          `  Part ${partNumber}: ${(partData.length / MB).toFixed(0)} MiB (${pct}%)...\r`,
        );

        const etag = await uploadPart(token, keyArg, uploadId, partNumber, partData);
        parts.push({ part_number: partNumber, etag });
        console.log(
          `  Part ${partNumber}: ${(partData.length / MB).toFixed(0)} MiB — etag: ${etag.slice(0, 20)}...`,
        );

        offset = end;
        partNumber++;
      }

      await completeMultipart(token, keyArg, uploadId, parts);
      console.log(`\nMultipart upload complete! ${parts.length} parts.`);
      return;
    } catch (err) {
      console.log(`\nMultipart upload failed (${err instanceof Error ? err.message : err})`);
      console.log('Falling back to direct PUT...\n');
    }
  }

  // Direct PUT fallback — read file and upload in one shot
  console.log('Reading file for direct PUT...');
  const fileData = readFileSync(fileArg);
  console.log(`Uploading ${(fileData.length / GB).toFixed(3)} GB via CF API direct PUT...`);
  await directPut(token, keyArg, new Uint8Array(fileData.buffer));
  console.log('Direct PUT complete!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

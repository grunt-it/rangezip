/**
 * Destination handling — where extracted files are written.
 *
 * Two modes:
 *   - `demo`: the project's own R2 bucket (the `OUTPUT` binding), ephemeral,
 *     auto-cleaned after a TTL. No credentials involved.
 *   - `byo`: a user-supplied S3/R2-compatible bucket, written via SigV4
 *     (`aws4fetch`). Files are KEPT — never cleaned up (it's the user's data).
 *
 * Security model for BYO credentials (non-negotiable, see README):
 *   The access key + secret are TRANSIENT — they live only in the DO's
 *   in-memory job state for the duration of the run. They are NEVER written to
 *   DO storage / SQLite, NEVER logged, and NEVER returned in any API response.
 *   They are discarded when the run completes (the DO instance forgets them).
 *
 * This module splits, per the repo convention, into:
 *   - pure helpers (URL building, config validation) — unit-testable, no IO;
 *   - the SigV4-backed `Bucket` layer + the validate operation — the IO shell.
 */

import { AwsClient } from 'aws4fetch';
import { Effect, Layer } from 'effect';
import { Bucket } from './effect/services';
import { R2WriteError } from './effect/errors';
import type { MetricsSink } from './effect/metrics-sink';

/** User-supplied destination config for BYO mode. */
export interface ByoConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Optional key prefix WITHIN the bucket (separate from the per-job prefix). */
  readonly prefix?: string;
}

// -------------------------------------------------------------------------------------------------
// Pure helpers
// -------------------------------------------------------------------------------------------------

/** Result of validating a raw BYO config object from a request body. */
export type ParseByoResult =
  | { readonly ok: true; readonly value: ByoConfig }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate + normalise a raw BYO destination object. Pure: no network. Checks
 * required fields are non-empty strings and the endpoint is an http(s) URL.
 */
export function parseByoConfig(raw: unknown): ParseByoResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'destination must be an object' };
  }
  const r = raw as Record<string, unknown>;
  const required = ['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey'] as const;
  for (const field of required) {
    if (typeof r[field] !== 'string' || (r[field] as string).length === 0) {
      return { ok: false, reason: `destination.${field} must be a non-empty string` };
    }
  }
  const endpoint = (r.endpoint as string).replace(/\/+$/, '');
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, reason: 'destination.endpoint must be an http(s) URL' };
    }
  } catch {
    return { ok: false, reason: 'destination.endpoint is not a valid URL' };
  }
  if (r.prefix !== undefined && typeof r.prefix !== 'string') {
    return { ok: false, reason: 'destination.prefix must be a string when provided' };
  }
  return {
    ok: true,
    value: {
      endpoint,
      region: r.region as string,
      bucket: r.bucket as string,
      accessKeyId: r.accessKeyId as string,
      secretAccessKey: r.secretAccessKey as string,
      prefix: r.prefix as string | undefined,
    },
  };
}

/**
 * Build the full object URL for a key in a BYO bucket. Pure. Joins
 * `endpoint/bucket/key`, collapsing redundant slashes, and percent-encodes each
 * key segment (preserving `/` path separators) so spaces / unicode in filenames
 * don't break the request. Path-style addressing (endpoint/bucket/key) is the
 * most broadly compatible across S3, R2, MinIO, Backblaze, etc.
 */
export function buildObjectUrl(endpoint: string, bucket: string, key: string): string {
  const cleanEndpoint = endpoint.replace(/\/+$/, '');
  const cleanKey = key.replace(/^\/+/, '');
  const encodedKey = cleanKey
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${cleanEndpoint}/${encodeURIComponent(bucket)}/${encodedKey}`;
}

/**
 * Compose the in-bucket prefix and the per-job prefix into one key prefix.
 * Pure. Drops empty segments and collapses slashes.
 */
export function composePrefix(bucketPrefix: string | undefined, jobPrefix: string): string {
  return [bucketPrefix, jobPrefix]
    .map((p) => (p ?? '').replace(/^\/+|\/+$/g, ''))
    .filter((p) => p.length > 0)
    .join('/');
}

// -------------------------------------------------------------------------------------------------
// SigV4 Bucket layer (IO shell)
// -------------------------------------------------------------------------------------------------

/** Build an `AwsClient` for a BYO config. */
function awsClient(config: ByoConfig): AwsClient {
  return new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: config.region,
  });
}

/**
 * A `Bucket` that writes via SigV4 PUT to a user-supplied S3/R2 endpoint.
 * The body is the same streamed `ReadableStream` used for R2, with an exact
 * `Content-Length`, so memory discipline is preserved end to end. Records each
 * successful write to the metrics sink.
 *
 * NOTE: the `config` (including secret) is captured in this closure for the run
 * only. It is never persisted or logged — the DO discards it on completion.
 */
export function makeByoBucket(config: ByoConfig, metrics?: MetricsSink): Layer.Layer<Bucket> {
  const client = awsClient(config);
  const urlFor = (key: string) => buildObjectUrl(config.endpoint, config.bucket, key);
  return Layer.succeed(Bucket, {
    put: (key, body, size) =>
      Effect.tryPromise({
        try: () =>
          client.fetch(urlFor(key), {
            method: 'PUT',
            body,
            headers: { 'Content-Length': String(size) },
          }),
        catch: (cause) => new R2WriteError(`Failed to PUT "${key}" to destination bucket`, cause),
      }).pipe(
        Effect.flatMap((res) =>
          res.ok
            ? Effect.sync(() => metrics?.r2Write())
            : Effect.fail(
                new R2WriteError(
                  `Destination bucket rejected PUT of "${key}" (status ${res.status})`,
                ),
              ),
        ),
      ),

    // BYO multipart uses the standard S3 multipart API over SigV4 (the same
    // shape R2's own S3-compatible endpoint speaks). `payload` carries the S3
    // `uploadId`; each part's `payload` is its returned ETag.
    createMultipart: (key) =>
      Effect.tryPromise({
        try: () => client.fetch(`${urlFor(key)}?uploads`, { method: 'POST' }),
        catch: (cause) => new R2WriteError(`Failed to start multipart upload for "${key}"`, cause),
      }).pipe(
        Effect.flatMap((res) =>
          res.ok
            ? Effect.tryPromise({
                try: async () => {
                  const uploadId = extractXmlTag(await res.text(), 'UploadId');
                  if (!uploadId) {
                    throw new Error('CreateMultipartUpload response had no UploadId');
                  }
                  return { key, payload: uploadId };
                },
                catch: (cause) =>
                  new R2WriteError(`Could not parse multipart upload id for "${key}"`, cause),
              })
            : Effect.fail(
                new R2WriteError(
                  `Destination bucket rejected multipart create for "${key}" (status ${res.status})`,
                ),
              ),
        ),
      ),

    uploadPart: (handle, partNumber, body, size) =>
      Effect.tryPromise({
        try: () =>
          client.fetch(
            `${urlFor(handle.key)}?partNumber=${partNumber}&uploadId=${encodeURIComponent(
              handle.payload as string,
            )}`,
            { method: 'PUT', body, headers: { 'Content-Length': String(size) } },
          ),
        catch: (cause) =>
          new R2WriteError(
            `Failed to upload part ${partNumber} of "${handle.key}" to destination bucket`,
            cause,
          ),
      }).pipe(
        Effect.flatMap((res) => {
          const etag = res.headers.get('etag');
          return res.ok && etag
            ? Effect.succeed({ partNumber, payload: etag })
            : Effect.fail(
                new R2WriteError(
                  `Destination bucket rejected part ${partNumber} of "${handle.key}" (status ${res.status})`,
                ),
              );
        }),
      ),

    completeMultipart: (handle, parts, _size) =>
      Effect.tryPromise({
        try: () =>
          client.fetch(
            `${urlFor(handle.key)}?uploadId=${encodeURIComponent(handle.payload as string)}`,
            {
              method: 'POST',
              body: buildCompleteMultipartXml(parts),
              headers: { 'Content-Type': 'application/xml' },
            },
          ),
        catch: (cause) =>
          new R2WriteError(`Failed to complete multipart upload of "${handle.key}"`, cause),
      }).pipe(
        Effect.flatMap((res) =>
          // S3 can return 200 with an error body, so check the body too.
          res.ok
            ? Effect.tryPromise({
                try: async () => {
                  const text = await res.text();
                  if (text.includes('<Error>')) {
                    throw new Error(`CompleteMultipartUpload returned an error body`);
                  }
                  metrics?.r2Write();
                },
                catch: (cause) =>
                  new R2WriteError(`Destination bucket failed to complete "${handle.key}"`, cause),
              })
            : Effect.fail(
                new R2WriteError(
                  `Destination bucket rejected multipart complete for "${handle.key}" (status ${res.status})`,
                ),
              ),
        ),
      ),

    abortMultipart: (handle) =>
      Effect.promise(async () => {
        try {
          await client.fetch(
            `${urlFor(handle.key)}?uploadId=${encodeURIComponent(handle.payload as string)}`,
            { method: 'DELETE' },
          );
        } catch {
          // Best-effort — incomplete S3/R2 multipart uploads are reaped by the
          // bucket's lifecycle policy if this cleanup doesn't land.
        }
      }),
  });
}

/** Pull the first `<Tag>…</Tag>` text out of an S3 XML response. Pure, regex-based. */
function extractXmlTag(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(xml);
  return match ? (match[1] ?? null) : null;
}

/** Build the `CompleteMultipartUpload` request body from the uploaded parts. */
function buildCompleteMultipartXml(
  parts: readonly { partNumber: number; payload: unknown }[],
): string {
  const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  const body = ordered
    .map(
      (p) =>
        `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(
          String(p.payload),
        )}</ETag></Part>`,
    )
    .join('');
  return `<CompleteMultipartUpload>${body}</CompleteMultipartUpload>`;
}

/** Minimal XML attribute/text escaping for the ETag values we echo back. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// -------------------------------------------------------------------------------------------------
// Validate-destination (IO shell)
// -------------------------------------------------------------------------------------------------

/** Result of a destination access check. */
export type ValidateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate write access to a BYO bucket with a cheap, real round-trip: PUT a
 * tiny `${prefix}/.rangezip-check` object then DELETE it. If both succeed the
 * credentials can write (and clean up after themselves) in that prefix. Any
 * non-2xx becomes a clear pass/fail reason. Returns a typed result; the secret
 * is never echoed in the reason string.
 */
export async function validateDestination(config: ByoConfig): Promise<ValidateResult> {
  const client = awsClient(config);
  const prefix = composePrefix(config.prefix, '');
  const checkKey = prefix ? `${prefix}/.rangezip-check` : '.rangezip-check';
  const url = buildObjectUrl(config.endpoint, config.bucket, checkKey);

  try {
    const putRes = await client.fetch(url, {
      method: 'PUT',
      body: 'rangezip access check',
      headers: { 'Content-Type': 'text/plain' },
    });
    if (!putRes.ok) {
      return {
        ok: false,
        reason: describeStatus(putRes.status, 'write'),
      };
    }
    // Best-effort cleanup of the probe object. A failed DELETE still means the
    // key COULD be written, but signals the key lacks delete rights — surface it.
    const delRes = await client.fetch(url, { method: 'DELETE' });
    if (!delRes.ok && delRes.status !== 404) {
      return {
        ok: false,
        reason: `Wrote the test object but could not delete it (status ${delRes.status}); the key needs s3:DeleteObject on this prefix.`,
      };
    }
    return { ok: true };
  } catch (cause) {
    // Network / DNS / CORS-style failure — no status to read.
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, reason: `Could not reach the destination endpoint: ${message}` };
  }
}

/** Map an HTTP status from the validate probe to a human reason. */
function describeStatus(status: number, op: 'write'): string {
  switch (status) {
    case 403:
      return `Access denied (403) — the key cannot ${op} to this bucket/prefix. Check the key has s3:PutObject + s3:DeleteObject scoped to this path.`;
    case 401:
      return `Unauthorized (401) — the access key / secret were rejected. Check the credentials.`;
    case 404:
      return `Bucket not found (404) — check the bucket name and endpoint.`;
    case 301:
    case 307:
      return `Wrong region (${status}) — the endpoint/region don't match where this bucket lives.`;
    default:
      return `Destination rejected the test ${op} (status ${status}).`;
  }
}

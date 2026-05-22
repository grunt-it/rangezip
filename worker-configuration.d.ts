/**
 * Ambient binding types.
 *
 * The runtime/global types (R2Bucket, DurableObjectNamespace, …) come from
 * `@cloudflare/workers-types` (see tsconfig `types`). This file only declares
 * the binding shape — the `Cloudflare.Env` interface that `cloudflare:test`
 * and `cloudflare:workers` resolve `env` against in tests. Keep it in sync with
 * the bindings in `wrangler.jsonc`.
 */

interface RangezipEnv {
  OUTPUT: R2Bucket;
  EXTRACT_JOB: DurableObjectNamespace<import('./src/worker').ExtractJob>;
  /** Comma-separated list of multi-use access codes (secret). */
  ACCESS_CODES?: string;
  /** HMAC key for signing session cookies (secret). */
  SESSION_SECRET?: string;
  /** Demo-bucket cleanup TTL in hours (var, default 2). */
  EXTRACT_TTL_HOURS?: string;
}

declare namespace Cloudflare {
  interface Env extends RangezipEnv {}
}

interface Env extends RangezipEnv {}

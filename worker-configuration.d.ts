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
}

declare namespace Cloudflare {
  interface Env extends RangezipEnv {}
}

interface Env extends RangezipEnv {}

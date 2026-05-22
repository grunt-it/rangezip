import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Tests run inside the Workers runtime (workerd) via the Cloudflare Vitest pool,
 * so they exercise the REAL `DecompressionStream`, `FixedLengthStream`, R2, and
 * Durable Object SQLite — not Node shims. The Worker config (bindings, DO
 * migrations) is taken straight from `wrangler.jsonc`.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
});

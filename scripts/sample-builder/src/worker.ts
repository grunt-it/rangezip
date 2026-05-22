/**
 * worker.ts — entry for the TEMPORARY sample-builder Worker.
 *
 * Routes:
 *   POST /build?size=10gb|30gb        -> start a resumable build (one DO per size)
 *   GET  /status?size=10gb|30gb       -> poll build progress
 *   POST /abort?size=10gb|30gb        -> abort an in-flight multipart upload
 *
 * The DO does all the work (generate ZIP64 + R2 multipart upload). This Worker
 * is just the trigger surface. DELETE this whole Worker with `wrangler delete`
 * once the two samples are uploaded — it must leave no stray deployed Worker.
 */

import { SampleBuilder } from './builder-do';

const GB = 1024 * 1024 * 1024;

const SIZES: Record<string, { key: string; target: number }> = {
  '10gb': { key: 'sample-10gb.zip', target: 10 * GB },
  '30gb': { key: 'sample-30gb.zip', target: 30 * GB },
};

interface Env {
  SAMPLES: R2Bucket;
  BUILDER: DurableObjectNamespace;
}

export { SampleBuilder };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const size = (url.searchParams.get('size') ?? '').toLowerCase();
    const spec = SIZES[size];
    if (!spec) return new Response('pass ?size=10gb|30gb', { status: 400 });

    const id = env.BUILDER.idFromName(`sample-${size}`);
    const stub = env.BUILDER.get(id);
    const path = url.pathname;

    if (path === '/build' && request.method === 'POST') {
      return stub.fetch(
        `https://do/?action=start&key=${encodeURIComponent(spec.key)}&target=${spec.target}`,
      );
    }
    if (path === '/status') {
      return stub.fetch('https://do/?action=status');
    }
    if (path === '/abort' && request.method === 'POST') {
      return stub.fetch('https://do/?action=abort');
    }
    return new Response('routes: POST /build, GET /status, POST /abort (all ?size=)', {
      status: 404,
    });
  },
};

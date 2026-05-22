/**
 * Worker entry point. Wires the Hono app to the fetch handler and re-exports
 * the `ExtractJob` Durable Object class so the runtime can find it.
 */

import { createApp, type Env } from './app';

export { ExtractJob } from './job';
export { Registry } from './registry/registry';

const app = createApp();

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

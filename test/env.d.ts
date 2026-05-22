/// <reference types="@cloudflare/vitest-pool-workers" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

// The references above pull in the Workers Vitest pool ambient types plus the
// `cloudflare:test` module declarations (env, fetchMock, runInDurableObject, …).
// The augmentation below types the `env` imported from `cloudflare:workers`
// against our bindings (`Env` comes from worker-configuration.d.ts).
declare module 'cloudflare:workers' {
  interface ProvidedEnv extends Env {}
}

export {};

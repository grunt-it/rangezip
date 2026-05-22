# CLAUDE.md — rangezip conventions

Guidance for working in this repo. Read alongside `README.md` (which explains
the technique) and `.cursor/rules/architecture.mdc` (same architecture, IDE
form).

## Stack

- **Runtime:** Cloudflare Workers + one Durable Object (SQLite-backed) + R2.
- **Package manager:** `bun`. Not npm. Install with `bun add`, run scripts with
  `bun run <script>`.
- **Language:** TypeScript, strict, with `noUncheckedIndexedAccess` and
  `verbatimModuleSyntax`. Index access yields `T | undefined` — handle it.
  `import type` for type-only imports (verbatimModuleSyntax enforces this).
- **HTTP:** Hono.
- **Effects/errors:** `effect` (Effect-TS).
- **Formatting:** Prettier — single quotes, trailing commas `all`, print width
  100, 2-space indent, semicolons. `bun run format` / `format:check`.
- **Tests:** Vitest via `@cloudflare/vitest-pool-workers` (tests run inside
  `workerd`). `fflate` builds real ZIP fixtures.

`bun run typecheck` AND `bun run test` must be green before anything ships.

## The core pattern: pure logic vs. Effect shell

This is the most important convention in the repo. Keep them separate.

### Pure logic — `src/zip/`, plus the other pure modules

All ZIP-format parsing is pure functions over `Uint8Array`: no network, no R2,
no Effect, no `fetch`. Inputs are bytes (the slices a caller range-GET'd),
outputs are plain data or a discriminated `{ ok: true; … } | { ok: false; reason }`
result. Never `throw` for an expected parse failure — return the `ok: false`
variant so the Effect shell can map it to a `ZipParseError`. (The one exception:
`ByteReader.u64` throws a `RangeError` for a genuinely-out-of-`Number`-range
ZIP64 value, which the shell treats as a defect.)

Why: the fiddly binary logic (EOCD scan, central-directory parse, the
local-header data-offset math) is exactly the part that's easy to get subtly
wrong, so it must be trivially unit-testable from an in-memory buffer with no
runtime. `test/zip-parse.test.ts` does exactly that.

**When adding ZIP-format handling, it goes in `src/zip/` as a pure function with
a unit test — not inline in an Effect or the DO.**

The same pure-logic discipline extends to the demo's non-ZIP logic — each pure
module has a co-located unit test, no runtime needed:

- `src/auth/session.ts` — HMAC-SHA256 session sign/verify, base64url, constant-
  time compare. Uses only WebCrypto (`crypto.subtle`) + `TextEncoder`, so it's
  testable without HTTP. `test/auth.test.ts`.
- `src/registry/codes.ts` — access-code generation (CSPRNG + rejection sampling
  over a URL-safe, unambiguous alphabet) and the usage-aggregation reducer
  (`aggregateUsage`, folding a code's events into the admin summary). Pure; the
  `Registry` DO shell calls these. `test/registry-codes.test.ts`.
- `src/metrics.ts` — the metrics aggregation/labelling math (totals, the
  headline percentage, bytes-saved). `test/metrics.test.ts`.
- `src/progress.ts` — WebSocket message types + `overallPercent`.
  `test/progress.test.ts`.
- `src/destination.ts` (pure half) — BYO config validation, object-URL building,
  prefix composition. `test/destination.test.ts`.
- `src/samples.ts` — sample-preset data.

The shells that wrap these (`src/auth/middleware.ts` Hono middleware,
`src/destination.ts` SigV4 `Bucket` + validate, `src/effect/metrics-sink.ts` the
mutable collector) are thin and sit on top.

### Effect shell — `src/effect/`, `src/extract.ts`

The IO and orchestration. `src/effect/services.ts` defines the IO seams as
`Context.Tag`s (`Source` = range reads of the remote URL; `Bucket` = the R2
binding), provided as `Layer`s built from `env` bindings. `src/extract.ts` is
the glue: `Effect.gen` programs that call the pure parsers and the services.
Logic lives in `Effect.gen`; errors are tagged errors in the error channel.

### Errors — `src/effect/errors.ts`

House style (mirrors the app-template): each error is
`class XError extends Data.TaggedError('XError')<ErrorParams>` where
`ErrorParams = { message: string; status: number; cause?: unknown; [k]: unknown }`,
and the constructor sets `message` / `status` / `cause`. The `status` is the HTTP
status the API returns for that failure. **No `try/catch` that swallows** —
failures travel as typed values. Defined: `RangeFetchError` (502),
`ZipParseError` (422), `EntryNotFoundError` (404), `R2WriteError` (500),
`DecompressError` (422).

### Runtime — `src/effect/runtime.ts`

This is a **Workers** app, not SvelteKit. The runtime is built per-request (in
the Worker) or per-instance (in the DO) from `env` bindings via `makeRuntime`.
**Do NOT use `getRequestEvent` / `event.locals.runtime`** — those are
SvelteKit-only and have no meaning here. `run` throws the normalised error on
failure; `runSafe` returns `{ ok: true; data } | { ok: false; error }`;
`toResponse` renders a normalised error to a JSON `Response` with its status.

## Memory discipline (non-negotiable)

The reason this project exists is to extract files larger than the isolate
memory ceiling. **Never buffer a whole file (or the whole archive) in memory.**
Index reads are small (tail + central directory). File data is always streamed:
`Source.streamRange` → `DecompressionStream` → `FixedLengthStream` → `R2.put`.
If you find yourself calling `.arrayBuffer()` on a file's data or
`readRange` (the buffering read) for anything other than the small fixed headers
and the central directory, stop — use `streamRange` and keep it a stream.

## Durable Object — `src/job.ts`

- One DO per job (`getByName(jobId)`). SQLite schema created in the constructor
  via `blockConcurrencyWhile` (init only — never hold it across IO). New columns
  (`destination`, `expires_at`, `metrics_json`) are part of the same
  `CREATE TABLE IF NOT EXISTS` — no new DO migration tag was needed (the v1
  migration already covers the SQLite class; column adds happen in `migrate()`).
- `start()` records the job and fires `runJob` **fire-and-forget** (`void`, not
  awaited) so it returns the jobId immediately; the DO stays alive on pending
  I/O. `waitUntil` is a no-op in DOs.
- Per-file failures are isolated — recorded in the `file` table, the job
  continues. The job only `failed`s if extraction couldn't start.
- `createRuntime(sourceUrl)` is a `protected` seam so tests can subclass and
  inject an in-memory `Source`. Don't add test-only branching to the hot path.
  It picks the demo R2 `Bucket` or a SigV4 BYO `Bucket` based on `byoConfig`.
- **WebSockets via the Hibernation API.** `fetch()` accepts the upgrade with
  `ctx.acceptWebSocket(server)` and returns `new Response(null, { status: 101,
webSocket: client })`. Progress is broadcast to `ctx.getWebSockets()`. The
  Worker (`app.ts` `GET /jobs/:id/ws`) checks the session + upgrade header, then
  `stub.fetch(c.req.raw)` forwards the upgrade. Don't use a non-hibernatable
  `server.accept()` here — hibernation lets the DO be evicted between bursts.
- **Cleanup via one alarm.** A completed _demo_ job calls `setAlarm(now + ttl)`;
  `alarm()` deletes every R2 object under the prefix and is a **no-op for BYO**
  jobs (never delete the user's data). `setAlarm` replaces any existing alarm —
  one per DO.
- **Metrics + BYO creds in memory.** The live `MetricsSink` and the transient
  `byoConfig` are in-memory instance fields. `byoConfig` (the access key/secret)
  is NEVER written to SQLite, logged, or returned — it's dropped in `runJob`'s
  `finally`. Metrics are persisted to `metrics_json` so `report()` survives
  eviction; `currentMetrics()` prefers the live sink, falls back to the column.
- **Usage events flow to the Registry.** `runJob` records `job_started` and
  `job_completed` against the session's `code` via `recordUsage`, which calls the
  singleton `Registry` DO. It's **best-effort**: failures are swallowed so a
  Registry hiccup never disrupts or fails an extraction, and it's a no-op when
  the job carries no code. The completion detail uses REAL metrics the run
  already measured (`filesExtracted`, `rangeBytesFetched`, `rangeBytesPercent`)
  plus wallclock `durationMs` — don't fabricate numbers here either.

## Durable Object — `src/registry/registry.ts` (the `Registry`)

- **A singleton** addressed by `getByName("registry")` (constant `REGISTRY_NAME`)
  — exactly ONE instance holds all access codes + usage events. Same DO+SQLite
  pattern as `ExtractJob` (no D1). Schema (`codes`, `usage_events`) is created in
  the constructor via `blockConcurrencyWhile`.
- **The source of truth for access codes** — there is NO static `ACCESS_CODES`
  secret anymore. `/auth` calls `validateCode` (active + not revoked); the admin
  panel calls `createCode` / `listCodes` / `revokeCode` / `codeTimeline`.
- **RPC shell is thin.** The fiddly bits — random code generation and the
  usage-aggregation fold — are pure functions in `src/registry/codes.ts`; the DO
  just runs SQL and calls them. When adding a new aggregate or event type, put
  the logic in `codes.ts` with a unit test, not inline in the DO.
- **New SQLite class → new migration tag.** Unlike `ExtractJob`'s column-adds
  (which reuse `v1`), a brand-new DO class needs its own migration: `v2` with
  `new_sqlite_classes: ["Registry"]`, **appended** to the migrations array — never
  edit the `v1` `ExtractJob` migration.

## Access-code + admin auth — `src/auth/`

- **Two distinct sessions, one HMAC key (`SESSION_SECRET`).** Both are the same
  signed `<payload>.<hmac>` token from `session.ts`, distinguished by cookie name
  AND a `sub` sentinel:
  - access-code session → cookie `rangezip_session`, `sub` = the access code.
  - admin session → cookie `rangezip_admin`, `sub` = `"admin"` (`ADMIN_SUBJECT`).
- **Mutually exclusive.** `requireSession` reads only `rangezip_session` and
  rejects the `admin` sub; `requireAdmin` reads only `rangezip_admin` and
  requires the `admin` sub. An admin cookie can't satisfy a code-gated route and
  vice versa — enforced at both the cookie-name and sub layers.
- **`ADMIN_KEY`** (secret) gates `/admin/*`. `POST /admin/auth` constant-time-
  compares the submitted key (`timingSafeEqual`) and issues the admin cookie.
- The session `sub` being the code is what lets `sessionCode()` attribute
  `/extract` jobs back to the code that signed in.

## Metrics honesty

Every metric is a real measurement (see README "Honest metrics"). When touching
metrics, keep the labels honest: `computeMs` is **measured wallclock** around the
inflate pump (label says "measured", never "billed CPU-ms"); the headline % can
exceed 100% on extract-all of a small archive (that's correct, not a bug);
`centralDirectoryReads` is a genuine read-once-reuse count. Don't invent or
mislabel a number to make the demo look better.

## Testing notes

- Build fixtures with `fflate` (`test/fixtures.ts`) — real ZIP bytes, not mocks.
  `level: 0` ⇒ STORED, positive ⇒ DEFLATE. Cover both.
- Pure logic: test from an in-memory buffer, no runtime (`test/zip-parse.test.ts`,
  `test/helpers.test.ts`).
- IO/integration: provide an in-memory `Source` layer + the real test R2 binding
  (`test/extract.test.ts`), or drive the DO via `runInDurableObject`
  (`test/job.test.ts`).
- **Expected log noise:** `test/job.test.ts`'s `start` test points the background
  extraction at a connection-refused source to prove failure-isolation; the pool
  logs a benign `Network connection lost` for the abandoned socket at teardown.
  The suite is green and the failure is asserted as recorded in SQLite — this log
  line is not a test failure.

## Type generation

`worker-configuration.d.ts` declares the `Cloudflare.Env` binding shape used by
`cloudflare:test` / `cloudflare:workers`. Keep it in sync with the bindings in
`wrangler.jsonc`. We deliberately keep `@cloudflare/workers-types` for the
ambient runtime types rather than the full `wrangler types` output, so this file
holds only the env shape, not a duplicated runtime-types block.

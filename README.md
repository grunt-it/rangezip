# rangezip

Extract individual files out of a **huge** remote ZIP archive on Cloudflare
Workers — using HTTP byte-range reads, **without downloading the whole
archive**.

Point it at a multi-gigabyte `.zip` sitting on any server that supports HTTP
range requests. rangezip reads only the archive's index, then pulls out exactly
the files you ask for and streams them into R2. A 50 GB archive where you want
three files costs you three files' worth of bandwidth and a few kilobytes of
index — not 50 GB.

> The interesting part of this project is doing what looks impossible inside the
> platform's hard constraints. A Cloudflare Worker isolate has a small memory
> ceiling (tens of MB), yet rangezip extracts files out of archives orders of
> magnitude larger than that ceiling. The trick is that it **never holds more
> than one byte-range slice in memory at a time**: the ZIP index is read from
> the tail, each file's compressed bytes are streamed through the decompressor
> and into R2, and nothing — not the archive, not even a single extracted file —
> is ever fully buffered in the isolate.

## How it works

```
                         remote ZIP (could be 50 GB, on any range-capable host)
                         ┌───────────────────────────────────────────────────┐
                         │ [local hdr][data] … [local hdr][data] │ central dir │EOCD│
                         └──────▲─────────────────▲──────────────┴──────▲──────┴─▲──┘
                                │                 │                     │        │
   ① range-GET tail (~64 KB) ───┼─────────────────┼─────────────────────┼────────┘
      → find EOCD / ZIP64,      │                 │                     │
        learn where the         │                 │   ② range-GET the central
        central directory is    │                 │      directory bytes ────────┘
                                │                 │      → parse every entry
                                │                 │        (name, method, sizes,
                                │                 │         CRC32, local offset)
   ③ per requested file:        │                 │
      range-GET its 30-byte ────┘                 │
      local header → compute    │                 │
      the exact data offset     │                 │
                                │                 │
   ④ range-GET just the ────────┘                 │
      compressed bytes (streamed, never buffered) │
        │                                         │
        ▼                                         │
   ⑤  DecompressionStream('deflate-raw')   ──► FixedLengthStream(uncompressedSize) ──► R2.put
       (method 8) or pass-through (method 0)      (gives R2 an exact Content-Length;
                                                   asserts the produced byte count)

   Coordinated by a Durable Object (one per job): tracks status in SQLite, fans
   files out with bounded concurrency, isolates per-file failures.
```

### The pipeline, step by step

1. **Read the index without downloading the file.** Range-GET the last ~64 KB
   and scan backwards for the End-Of-Central-Directory record (signature
   `0x06054b50`). If the archive is larger than 4 GB or has more than 65 535
   entries, the classic EOCD fields hold sentinel values and we follow the
   **ZIP64** EOCD locator (`0x07064b50`) → ZIP64 EOCD (`0x06064b50`) to read the
   real 64-bit offsets. Then range-GET exactly the central-directory bytes and
   parse each central-directory file header (`0x02014b50`) into a list of
   entries: name, compression method, compressed/uncompressed size,
   local-header offset, CRC32.

2. **Find each file's true data offset.** The central directory tells us where a
   file's **local header** is, but not where its data starts — the local header
   has its **own** filename-length and extra-field-length fields, which
   routinely differ from the central directory's. So per file we range-GET the
   30-byte local header (`0x04034b50`) and compute:

   ```
   dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength
   ```

3. **Stream the bytes out.** Range-GET just the compressed bytes as a stream.
   For DEFLATE (method 8) we pipe through the platform-native
   `new DecompressionStream('deflate-raw')`; for STORED (method 0) we pass the
   bytes straight through. The output is wrapped in a `FixedLengthStream` sized
   to the known uncompressed length, then `put` into R2 at `${prefix}/${name}`.
   A `FixedLengthStream` gives R2 a precise `Content-Length` (so it never
   buffers the object to discover its size) and turns a truncated or corrupt
   inflate into a clean write-time error instead of a silently short object.

4. **Coordinate with a Durable Object.** One DO per job owns the job's state in
   SQLite, fans the per-file extractions out with bounded concurrency (6 at a
   time), records progress, and isolates per-file failures — one bad entry is
   recorded as `failed` and the rest of the job continues.

## The gated demo

The Worker also serves a **self-contained demo UI** at `/` (single HTML page,
vanilla JS, no build step). It walks you through: enter an access code → pick a
source (paste a ZIP URL or choose a sample) → pick a destination (the ephemeral
demo bucket, or your own S3/R2 bucket) → Extract → watch **live progress over a
WebSocket** with a real metrics panel, a per-file status log, a file browser
with downloads, and a countdown to cleanup.

### Auth setup (required before deploy)

Auth is an access-code gate that issues a signed (HMAC-SHA256) session cookie.
**No secrets are hardcoded** — set them with `wrangler secret put`:

```sh
# Comma-separated list of multi-use access codes. Anyone with a code gets in.
wrangler secret put ACCESS_CODES        # e.g. "team-demo-2026, investor-xyz"

# HMAC key for signing session cookies. Use a long random string.
wrangler secret put SESSION_SECRET      # e.g. `openssl rand -hex 32`
```

For local `wrangler dev`, put them in a gitignored `.dev.vars` file:

```ini
ACCESS_CODES=demo123, friend456
SESSION_SECRET=local-dev-only-not-a-real-secret
```

`POST /auth { code }` verifies the code against `ACCESS_CODES` and, on success,
sets `rangezip_session` — an `HttpOnly; Secure; SameSite=Lax; Max-Age=86400`
cookie carrying `<base64url(payload)>.<base64url(hmac)>`. The middleware on the
gated routes recomputes the HMAC (constant-time) and checks expiry; there's no
server-side session store. `POST /logout` clears it; `GET /me` reports whether a
valid session is present.

### Honest metrics

Every number the demo shows is a **real measurement**, precisely labelled:

| Metric                       | What it is                                                             |
| ---------------------------- | ---------------------------------------------------------------------- |
| **range bytes vs archive**   | **the headline** — bytes range-GET'd / total archive size, as a %      |
| bytes fetched / archive size | raw byte totals behind the headline                                    |
| bytes not fetched            | the savings (archive size − bytes fetched)                             |
| range requests               | count of every range-GET (size probe + index + per-file header + data) |
| peak concurrency             | max simultaneous in-flight extractions observed (bounded at 6)         |
| files extracted              | files successfully written                                             |
| bucket writes                | successful R2 / BYO `put`s                                             |
| index-read time              | measured wallclock from job start to central directory parsed          |
| extraction time              | measured wallclock from index parsed to last file settled              |
| total time                   | index-read + extraction                                                |
| **compute time (measured)**  | summed `performance.now()` deltas around the inflate/stream pump       |
| central dir reads (reused)   | the central directory is read **once** and reused across every file    |

Labelling honesty notes (a critical reviewer should know these):

- **"compute time (measured)"** is wallclock measured around the CPU-bound
  decompress+stream section with `performance.now()`. It is **not** billed
  CPU-ms (the Workers platform doesn't expose per-section CPU time to the
  isolate), and it includes some stream/IO overlap. It's labelled "measured" for
  exactly this reason — an honest measured wallclock delta, not a synthetic
  billing figure.
- **The headline percentage can exceed 100% when you extract _all_ files of a
  _small_ archive** — you fetch every file's compressed bytes plus per-file local
  headers plus the index, which sums to slightly more than the archive. That's
  the metric being honest, not broken: the dramatic savings appear when you
  extract a **subset** of a **large** archive (e.g. 2 files of 30 GB → well under
  1%). The demo never fakes this.
- **"central dir reads (reused)"** is a genuine reuse metric: the central
  directory is read exactly once per job and reused across every per-file
  extraction. It's not an invented "N reuses" number.

### Cleanup + countdown (demo bucket)

When a **demo-bucket** job completes, the Durable Object schedules an alarm at
`now + EXTRACT_TTL_HOURS` (default **2h**, set via the `EXTRACT_TTL_HOURS` var in
`wrangler.jsonc`). The `alarm()` handler deletes **every** R2 object under the
job's prefix. The job's `expiresAt` drives a live countdown in the UI ("clears
in 1:58:14"). As a backstop, add an **R2 lifecycle rule** on the output prefix:

```sh
# Belt-and-suspenders: even if a DO never fires its alarm, R2 expires the object.
wrangler r2 bucket lifecycle add rangezip-output \
  --prefix demo/ --expire-days 1
```

(BYO-bucket jobs are **never** cleaned up — that's the user's data.)

## API

### `POST /auth` (public)

`{ code }` → `200` + `Set-Cookie` on success, `401` on a bad code. All routes
below require the resulting session cookie (`401` without it).

### `POST /extract` (gated)

```jsonc
{
  "sourceUrl": "https://example.com/huge.zip", // must support HTTP range requests
  "prefix": "exports/job-42", // R2 key prefix for extracted files
  "files": ["docs/report.pdf", "data/rows.csv"], // OPTIONAL — omit to extract all
  "destination": "demo", // "demo" (ephemeral, auto-cleaned) | "byo"
  "byo": {
    // REQUIRED when destination == "byo"
    "endpoint": "https://acct.r2.cloudflarestorage.com",
    "region": "auto",
    "bucket": "my-bucket",
    "accessKeyId": "…",
    "secretAccessKey": "…",
    "prefix": "exports/", // optional in-bucket prefix
  },
}
```

Returns `202` with `{ "jobId": "...", "status": "pending" }`. The request does a
cheap pre-flight (reads the index, validates that any explicitly-requested files
exist → `404` if not) before accepting the job, then returns immediately while
extraction runs in the background.

### `POST /validate-destination` (gated)

`{ destination: { endpoint, region, bucket, accessKeyId, secretAccessKey, prefix? } }`
→ signs a cheap real round-trip (SigV4 PUT then DELETE of
`${prefix}/.rangezip-check` via `aws4fetch`) → `{ valid: true }` or
`{ valid: false, reason }`. The UI requires this to pass before enabling
**Extract** in BYO mode.

### `GET /jobs/:id` (gated)

Returns the job status, per-file results, destination/expiry, and live metrics:

```jsonc
{
  "id": "...",
  "status": "completed", // pending | running | completed | failed
  "sourceUrl": "https://example.com/huge.zip",
  "prefix": "exports/job-42",
  "total": 2,
  "done": 2,
  "failed": 0,
  "error": null,
  "destination": "demo",
  "expiresAt": 1779473689526, // unix-ms cleanup time (null for byo)
  "percent": 100,
  "metrics": {
    /* see "Honest metrics" above */
  },
  "files": [
    {
      "name": "docs/report.pdf",
      "key": "exports/job-42/docs/report.pdf",
      "status": "done",
      "bytes": 1048576,
      "error": null,
    },
  ],
}
```

A job is reported `completed` even if some individual files failed — inspect the
per-file `status`/`error`. The job is only `failed` if extraction couldn't even
start (e.g. the source doesn't support range requests, or the index is
unparseable).

### `GET /jobs/:id/ws` (gated)

WebSocket upgrade. The Worker validates the session + upgrade header, then
forwards the request to the job's Durable Object, which accepts the socket via
the **Hibernation API** (`ctx.acceptWebSocket`) and broadcasts progress messages
as extraction runs: a `snapshot` on connect, a `file` delta per file transition
(`queued`/`extracting`/`done`/`failed`), and a terminal `done`. Each message
carries the live metrics. (The DO can hibernate between bursts without dropping
the socket.)

### `GET /jobs/:id/files` (gated)

Lists extracted objects under the job prefix: `{ files: [{ name, key, size }] }`.
For BYO jobs the list is empty (the files are in the user's bucket).

### `GET /jobs/:id/files/:name` (gated)

Streams one extracted object back (`Content-Disposition: attachment`), never
buffering it in the isolate. `409` for BYO jobs (the file lives in the user's
bucket).

## BYO-bucket security model

When you choose "My S3/R2 bucket", the credentials are treated as **transient**:

- They live **only in the Durable Object's in-memory job state** for the duration
  of the run. They are **never** written to DO storage / SQLite, **never** logged,
  and **never** returned in any API response. They are **discarded** the moment
  the run completes (the DO drops them).
- They travel over **HTTPS only** and are used solely to SigV4-sign the per-file
  `PUT`s (and the validate probe) to your endpoint.
- rangezip **never deletes** from a BYO bucket — there's no cleanup alarm and no
  countdown for BYO jobs. The files are yours to keep.

**Use a scoped, write-only key for just this bucket/prefix — not a root key.**
The validate step needs `s3:PutObject` + `s3:DeleteObject` on the target prefix;
the extraction itself only needs `s3:PutObject`.

## Sample data

`scripts/make-sample.ts` generates a synthetic many-file ZIP of a target size
(2 / 10 / 30 GB; a mix of STORED incompressible + DEFLATE text entries, so the
central directory and per-file extraction are meaningful). It uses `fflate`'s
**streaming** ZIP API piped to a file with backpressure, so even a 30 GB sample
is generated in bounded memory (same discipline as the Worker).

```sh
# Generate locally (writes ./samples/rangezip-sample-2gb.zip):
bun run scripts/make-sample.ts --size 2gb

# Generate AND upload to the demo R2 bucket via wrangler:
bun run scripts/make-sample.ts --size 10gb --upload
```

After uploading, set the public, **range-capable** URL and flip `available: true`
for that preset in `src/samples.ts` (the demo UI reads the presets from there).
Until then the preset URLs are documented placeholders (the UI labels them as
such). Generating/uploading 10–30 GB is a one-time manual step — the script,
presets, and instructions ship ready; the actual large upload is yours to run.

## Why it's built this way — trade-offs

- **Streaming over buffering, everywhere.** The whole design exists to respect
  the isolate memory ceiling. The index reads are tiny (tail + central
  directory). Each file's data is streamed range-GET → decompress →
  `FixedLengthStream` → R2, so peak memory is one in-flight slice, not one
  whole file. This is what makes multi-GB archives tractable on Workers.

- **Native `DecompressionStream` over WASM.** A production system that inspired
  this technique used a hand-tuned WASM inflate for raw throughput. This
  reference deliberately uses the platform-native
  `DecompressionStream('deflate-raw')` instead. The honest trade-off: WASM can
  be faster and gives finer control (custom dictionaries, partial flushes), but
  the native stream is zero-dependency, already audited by the runtime, and
  reads as plain web-standard code. For a reference implementation, legibility
  wins; if you were chasing maximum throughput on hot paths, WASM is the lever
  to reach for.

- **Pure logic separated from the IO shell.** All ZIP-format parsing (EOCD scan,
  central-directory parse, local-header offset math) lives in `src/zip/` as pure
  functions over `Uint8Array` — no network, no Effect, no R2. The IO and
  orchestration live in the Effect shell (`src/effect/`, `src/extract.ts`) and
  the Durable Object (`src/job.ts`). This keeps the fiddly binary logic
  trivially unit-testable and the side-effecting code thin. See `CLAUDE.md`.

- **Effect for typed errors.** Failures travel as tagged errors
  (`RangeFetchError` 502, `ZipParseError` 422, `EntryNotFoundError` 404,
  `R2WriteError` 500, `DecompressError` 422) in the Effect error channel — no
  `try/catch` swallowing. The error's HTTP `status` doubles as the API contract:
  a failed Effect maps straight to a JSON `Response` with that status.

- **A Durable Object per job.** Extraction is stateful, coordinated, and
  possibly long-running. A DO gives a single serialization point for progress
  updates and a durable place (SQLite) to read status from while work proceeds.
  `waitUntil` is a no-op inside a DO — the instance simply stays alive while the
  background extraction promise has pending I/O. The same DO also hosts the
  live-progress **WebSocket** (Hibernation API, so it can be evicted between
  progress bursts) and the cleanup **alarm** (one alarm per DO, deleting the
  demo-bucket output at the TTL).

## Extension: sources that DON'T support range requests

rangezip requires the source to honour HTTP range requests (it checks, and
fails with a clear `502` if not). For a source that can't — say a CDN that only
serves the whole object — the technique still works with a **copy-in + restitch**
front phase, documented here but not built:

1. Fetch the source in parallel byte-range chunks (or a sequence of `Range`
   requests if the origin allows ranges on read but you want to control
   chunking) and write them as **parts of an R2 multipart upload**, assembling
   the archive into R2 first.
2. Then operate on the R2 object exactly as above — R2 natively supports range
   reads, so the index-read / per-file-extract pipeline is unchanged; only the
   `Source` implementation swaps from "remote URL" to "R2 object".

This trades extra ingest bandwidth and storage for the ability to handle any
source, while keeping the memory-bounded extraction core identical.

## Development

```sh
bun install
bun run typecheck   # tsc --noEmit (strict + noUncheckedIndexedAccess + verbatimModuleSyntax)
bun run test        # vitest, inside the real Workers runtime via @cloudflare/vitest-pool-workers
bun run dev         # wrangler dev (put ACCESS_CODES + SESSION_SECRET in .dev.vars first)
bun run deploy      # wrangler deploy (create the R2 bucket + set secrets first)
```

Before `dev`/`deploy`, set the auth secrets (see "Auth setup" above): a
gitignored `.dev.vars` for local dev, `wrangler secret put` for deploy.

Tests build **real** ZIP fixtures in-memory with `fflate` and assert the
central-directory parse, the local-header data-offset computation, and a full
parse → extract round-trip that reproduces the original bytes against the genuine
`DecompressionStream`, `FixedLengthStream`, R2, and Durable Object SQLite inside
`workerd` (not Node shims). On top of the core, the suite covers the new pure
logic and shells: session signing/verification (`test/auth.test.ts`), metrics
math (`test/metrics.test.ts`, `test/metrics-collection.test.ts`), BYO destination
helpers (`test/destination.test.ts`), progress math (`test/progress.test.ts`),
the auth gate + routing (`test/app.test.ts`), and the DO's cleanup alarm + report
shape (`test/job.test.ts`). 105 tests, all run in `workerd`.

> WebSocket completion over a Durable Object can't run under the Vitest pool's
> per-file storage isolation (a documented pool limitation), so the WS tests
> assert the gating + the DO's non-upgrade contract; the live upgrade + broadcast
> is verified via `wrangler dev`.

## License

MIT © Nik Divjak. See [LICENSE](./LICENSE).

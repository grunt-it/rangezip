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

## API

### `POST /extract`

```jsonc
{
  "sourceUrl": "https://example.com/huge.zip", // must support HTTP range requests
  "prefix": "exports/job-42", // R2 key prefix for extracted files
  "files": ["docs/report.pdf", "data/rows.csv"] // OPTIONAL — omit to extract all
}
```

Returns `202` with `{ "jobId": "...", "status": "pending" }`. The request does a
cheap pre-flight (reads the index, validates that any explicitly-requested files
exist → `404` if not) before accepting the job, then returns immediately while
extraction runs in the background.

### `GET /jobs/:id`

Returns the job status and per-file results:

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
  "files": [
    { "name": "docs/report.pdf", "key": "exports/job-42/docs/report.pdf", "status": "done", "bytes": 1048576, "error": null },
    { "name": "data/rows.csv", "key": "exports/job-42/data/rows.csv", "status": "done", "bytes": 524288, "error": null }
  ]
}
```

A job is reported `completed` even if some individual files failed — inspect the
per-file `status`/`error`. The job is only `failed` if extraction couldn't even
start (e.g. the source doesn't support range requests, or the index is
unparseable).

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
  background extraction promise has pending I/O.

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
bun run dev         # wrangler dev
bun run deploy      # wrangler deploy (create the R2 bucket first; see wrangler.jsonc)
```

Tests build a **real** ZIP fixture in-memory with `fflate` (one DEFLATE entry,
one STORED entry, one nested path) and assert the central-directory parse, the
local-header data-offset computation, and a full parse → extract round-trip that
reproduces the original bytes — the extraction tests run against the genuine
`DecompressionStream`, `FixedLengthStream`, R2, and Durable Object SQLite inside
`workerd`, not Node shims.

## License

MIT © Nik Divjak. See [LICENSE](./LICENSE).

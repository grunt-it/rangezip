/**
 * Effect runtime for Workers, adapted from the app-template `run`/`runSafe`
 * pattern.
 *
 * The app-template builds its runtime from SvelteKit's `event.locals.runtime`
 * via `getRequestEvent()`. That is SvelteKit-only and has no meaning here — a
 * Worker has no per-request `locals`, and a Durable Object has no request event
 * at all. So we build a fresh `ManagedRuntime` from the `env` bindings at the
 * point of use (per request in the Worker, once per DO instance), provided the
 * `Source` and `Bucket` layers.
 *
 * `run`     — runs an Effect, throwing the mapped error on failure.
 * `runSafe` — runs an Effect, returning `{ ok: true; data } | { ok: false; error }`.
 * `toResponse` — turns a failed run into a JSON `Response` carrying the error's
 *                HTTP status, so the tagged-error `status` IS the HTTP contract.
 */

import { Cause, Effect, Exit, Layer, ManagedRuntime } from 'effect';
import { isTaggedError, type AppError } from './errors';
import { Bucket, makeHttpSource, makeR2Bucket, Source } from './services';
import type { MetricsSink } from './metrics-sink';

export type Services = Source | Bucket;
export type AppRuntime = ManagedRuntime.ManagedRuntime<Services, never>;

/**
 * Build a runtime bound to one source URL and one R2 bucket. An optional
 * `MetricsSink` is threaded into both services so range-GETs and R2 writes are
 * recorded as they happen (the Worker pre-flight omits it; the DO supplies one).
 */
export function makeRuntime(
  sourceUrl: string,
  bucket: R2Bucket,
  metrics?: MetricsSink,
): AppRuntime {
  const layer = Layer.mergeAll(makeHttpSource(sourceUrl, metrics), makeR2Bucket(bucket, metrics));
  return ManagedRuntime.make(layer);
}

/** Shape of a normalised error after a failed run. */
export interface NormalisedError {
  readonly message: string;
  readonly status: number;
  readonly tag: string;
  readonly extra: Record<string, unknown>;
}

export type RunResult<A> =
  | { readonly ok: true; readonly data: A }
  | { readonly ok: false; readonly error: NormalisedError };

/**
 * Run an Effect against the runtime and throw the normalised error on failure.
 * Use when the caller wants the value or an exception (e.g. inside a DO method
 * that has its own outer error handling).
 */
export async function run<A>(
  rt: AppRuntime,
  effect: Effect.Effect<A, AppError, Services>,
): Promise<A> {
  const exit = await rt.runPromiseExit(effect);
  return Exit.match(exit, {
    onSuccess: (value) => value,
    onFailure: (cause) => {
      throw normaliseCause(cause);
    },
  });
}

/** Run an Effect and surface success/failure as a tagged union — never throws. */
export async function runSafe<A>(
  rt: AppRuntime,
  effect: Effect.Effect<A, AppError, Services>,
): Promise<RunResult<A>> {
  const exit = await rt.runPromiseExit(effect);
  return Exit.match(exit, {
    onSuccess: (data) => ({ ok: true, data }),
    onFailure: (cause) => ({ ok: false, error: normaliseCause(cause) }),
  });
}

/** Render a normalised error as a JSON `Response` with its HTTP status. */
export function toResponse(error: NormalisedError): Response {
  return Response.json(
    { error: { tag: error.tag, message: error.message, ...error.extra } },
    { status: error.status },
  );
}

// -------------------------------------------------------------------------------------------------
// Cause handling
// -------------------------------------------------------------------------------------------------

/**
 * Reduce a `Cause` to a concrete error object. A `Fail` carries one of our
 * tagged errors; a `Die` is an unexpected defect, which we surface as a 500
 * rather than letting it escape untyped.
 */
function normaliseCause(cause: Cause.Cause<AppError>): NormalisedError {
  if (Cause.isFailType(cause) && isTaggedError(cause.error)) {
    return normalise(cause.error);
  }
  if (Cause.isDieType(cause)) {
    const defect = cause.defect;
    const message = defect instanceof Error ? defect.message : String(defect);
    return { message, status: 500, tag: 'Defect', extra: {} };
  }
  return { message: Cause.pretty(cause), status: 500, tag: 'Unknown', extra: {} };
}

/** Project a tagged error onto the wire shape, keeping only safe extra fields. */
function normalise(error: { _tag: string } & Record<string, unknown>): NormalisedError {
  const { _tag, message, status, cause: _cause, ...rest } = error;
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean') extra[key] = value;
  }
  return {
    message: typeof message === 'string' ? message : 'Unknown error',
    status: typeof status === 'number' ? status : 500,
    tag: _tag,
    extra,
  };
}

/**
 * The `Registry` Durable Object — the single source of truth for access codes
 * and the usage events attributed to them.
 *
 * Unlike `ExtractJob` (one DO per job), there is exactly ONE Registry instance:
 * the Worker always addresses it via `getByName("registry")`, so all codes and
 * usage live in one SQLite database. This is the same DO+SQLite pattern the repo
 * already uses (no D1) — the schema is created once in the constructor via
 * `blockConcurrencyWhile`, and the RPC methods are thin SQLite shells over the
 * pure logic in `./codes` (code generation, the usage-aggregation reducer).
 *
 * Tables:
 *   codes(code PK, label, created_at, revoked_at NULL)
 *   usage_events(id PK AUTOINCREMENT, code, type, detail /*json*\/, at)
 *
 * `validateCode` is the auth path: `/auth` calls it to decide whether a code may
 * sign in. `recordEvent` is the instrumentation path: session start, job start,
 * and job completion are logged here and later folded into per-code summaries by
 * the admin panel.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  aggregateUsage,
  generateCode,
  isCodeActive,
  type CodeRecord,
  type CodeSummary,
  type DetailObject,
  type UsageEvent,
} from './codes';

/** The fixed name every caller uses to address the singleton Registry. */
export const REGISTRY_NAME = 'registry';

/** Bindings the Registry needs — none beyond its own storage, so this is empty. */
export type RegistryEnv = Record<never, never>;

/** Result of validating a submitted code. */
export type ValidateResult = { readonly ok: true; readonly label: string } | { readonly ok: false };

interface CodeRow extends Record<string, SqlStorageValue> {
  code: string;
  label: string;
  created_at: number;
  revoked_at: number | null;
}

interface EventRow extends Record<string, SqlStorageValue> {
  id: number;
  code: string;
  type: string;
  detail: string | null;
  at: number;
}

export class Registry extends DurableObject<RegistryEnv> {
  constructor(ctx: DurableObjectState, env: RegistryEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS codes (
        code        TEXT PRIMARY KEY,
        label       TEXT NOT NULL DEFAULT '',
        created_at  INTEGER NOT NULL,
        revoked_at  INTEGER
      );
      CREATE TABLE IF NOT EXISTS usage_events (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        code   TEXT NOT NULL,
        type   TEXT NOT NULL,
        detail TEXT,
        at     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_events_code ON usage_events (code);
    `);
  }

  // -----------------------------------------------------------------------------------------------
  // RPC: codes
  // -----------------------------------------------------------------------------------------------

  /**
   * Create a new active code with a label. Generates a random URL-safe code via
   * the pure `generateCode`, retrying on the (astronomically unlikely) collision
   * so the returned code is always fresh. Returns the new code + its label.
   */
  async createCode(label: string): Promise<{ code: string; label: string }> {
    const cleanLabel = typeof label === 'string' ? label.trim() : '';
    // Retry on PK collision — generateCode is ~58 bits, so this effectively
    // never loops, but a bounded loop is cheap insurance.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode();
      const existing = this.ctx.storage.sql
        .exec<CodeRow>('SELECT code FROM codes WHERE code = ?', code)
        .toArray();
      if (existing.length > 0) continue;
      this.ctx.storage.sql.exec(
        'INSERT INTO codes (code, label, created_at, revoked_at) VALUES (?, ?, ?, NULL)',
        code,
        cleanLabel,
        Date.now(),
      );
      return { code, label: cleanLabel };
    }
    // Exhausted attempts — surfaced as a thrown error (the Worker maps to 500).
    throw new Error('Failed to generate a unique code');
  }

  /**
   * List every code with its usage aggregated from `usage_events`. Reads all
   * events once and folds them per-code via the pure `aggregateUsage` reducer.
   * Ordered newest-first.
   */
  async listCodes(): Promise<CodeSummary[]> {
    // `rowid DESC` is the stable tiebreak: two codes created in the SAME
    // millisecond have equal `created_at`, so ordering by that alone is
    // non-deterministic. rowid is monotonic insertion order, so the secondary
    // sort keeps "newest-first" deterministic even for codes minted back-to-back.
    const codes = this.ctx.storage.sql
      .exec<CodeRow>('SELECT * FROM codes ORDER BY created_at DESC, rowid DESC')
      .toArray();
    if (codes.length === 0) return [];

    const events = this.ctx.storage.sql
      .exec<EventRow>('SELECT id, code, type, detail, at FROM usage_events')
      .toArray();

    // Bucket events by code in one pass, then aggregate each code.
    const byCode = new Map<string, UsageEvent[]>();
    for (const row of events) {
      const list = byCode.get(row.code) ?? [];
      list.push(this.toUsageEvent(row));
      byCode.set(row.code, list);
    }

    return codes.map((row) => aggregateUsage(this.toCodeRecord(row), byCode.get(row.code) ?? []));
  }

  /** Revoke a code (sets `revoked_at`). Idempotent; a no-op for unknown codes. */
  async revokeCode(code: string): Promise<{ ok: boolean }> {
    const rows = this.ctx.storage.sql
      .exec<CodeRow>('SELECT revoked_at FROM codes WHERE code = ?', code)
      .toArray();
    const row = rows[0];
    if (!row) return { ok: false };
    if (row.revoked_at === null) {
      this.ctx.storage.sql.exec('UPDATE codes SET revoked_at = ? WHERE code = ?', Date.now(), code);
    }
    return { ok: true };
  }

  /**
   * Validate a submitted code for sign-in: it must exist and not be revoked.
   * Returns its label on success so the caller can attribute the session. This
   * is the replacement for the old static `ACCESS_CODES` matching.
   */
  async validateCode(code: string): Promise<ValidateResult> {
    const trimmed = typeof code === 'string' ? code.trim() : '';
    if (trimmed.length === 0) return { ok: false };
    const rows = this.ctx.storage.sql
      .exec<CodeRow>('SELECT * FROM codes WHERE code = ?', trimmed)
      .toArray();
    const record = rows[0] ? this.toCodeRecord(rows[0]) : null;
    return isCodeActive(record) ? { ok: true, label: record!.label } : { ok: false };
  }

  // -----------------------------------------------------------------------------------------------
  // RPC: usage events
  // -----------------------------------------------------------------------------------------------

  /**
   * Record a usage event attributed to a code. `detail` is serialised to JSON.
   * Best-effort: an event for an unknown/revoked code is still stored (it can't
   * leak access — only `validateCode` gates sign-in) so the timeline stays
   * complete. Lightweight by design — a few events per job.
   */
  async recordEvent(code: string, type: string, detail: unknown = {}): Promise<void> {
    if (typeof code !== 'string' || code.length === 0 || typeof type !== 'string') return;
    let detailJson: string | null = null;
    try {
      detailJson = detail === undefined ? null : JSON.stringify(detail);
    } catch {
      detailJson = null;
    }
    this.ctx.storage.sql.exec(
      'INSERT INTO usage_events (code, type, detail, at) VALUES (?, ?, ?, ?)',
      code,
      type,
      detailJson,
      Date.now(),
    );
  }

  /** The raw event timeline for one code, oldest-first (for the detail view). */
  async codeTimeline(code: string): Promise<UsageEvent[]> {
    const rows = this.ctx.storage.sql
      .exec<EventRow>(
        'SELECT id, code, type, detail, at FROM usage_events WHERE code = ? ORDER BY at ASC, id ASC',
        code,
      )
      .toArray();
    return rows.map((row) => this.toUsageEvent(row));
  }

  // -----------------------------------------------------------------------------------------------
  // Row mappers
  // -----------------------------------------------------------------------------------------------

  private toCodeRecord(row: CodeRow): CodeRecord {
    return {
      code: row.code,
      label: row.label,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    };
  }

  private toUsageEvent(row: EventRow): UsageEvent {
    let detail: DetailObject | null = null;
    if (row.detail) {
      try {
        const parsed = JSON.parse(row.detail) as unknown;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          detail = parsed as DetailObject;
        }
      } catch {
        detail = null;
      }
    }
    return { id: row.id, code: row.code, type: row.type, detail, at: row.at };
  }
}

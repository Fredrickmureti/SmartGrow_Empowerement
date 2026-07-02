/**
 * Architecture guard — Inventory stock adjustment RPCs.
 *
 * Two regressions broke Inventory > Stock Adjustment in the past:
 *
 * 1. `approve_stock_adjustment_atomic` was inserting a TEXT expression
 *    (`'stock-adj-' || p_adjustment_id::text`) into `journal_entries.source_id`,
 *    which is a UUID column. PostgreSQL surfaced this as
 *    `42883 operator does not exist: text = uuid` once downstream JE triggers
 *    compared the new row's source_id, and PostgREST returned a 404 envelope
 *    around the SQL error.
 *
 * 2. `apply_or_request_stock_adjustment` was inserting the raw uuid
 *    `v_adjustment_id` into `approval_rule_logs.entity_id`, which is a TEXT
 *    column. The pending-approval path silently failed for non-privileged users.
 *
 * This test scans every migration in the repo and fails if either pattern is
 * reintroduced. It does NOT block on schema column type changes — those are a
 * separate concern. It only enforces the contract that:
 *
 *   - JE inserts inside these RPCs put a real uuid into `source_id`
 *   - approval_rule_logs inserts inside these RPCs cast uuid -> text for
 *     `entity_id` (since the column is intentionally polymorphic text)
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = "supabase/migrations";

function readAllMigrations(): { file: string; sql: string }[] {
  return readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort() // filenames are timestamp-prefixed, so lexical sort = chronological
    .map((f) => ({ file: f, sql: readFileSync(join(MIG_DIR, f), "utf8") }));
}

function extractFunctionBodies(sql: string, fnName: string): string[] {
  // Capture each `CREATE OR REPLACE FUNCTION public.<fn>(...) ... $function$ ... $function$;`
  // (or matching $$ variant). Multiple definitions per file are supported.
  const re = new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(?:public\\.)?${fnName}[\\s\\S]*?\\$(function)?\\$([\\s\\S]*?)\\$(?:function)?\\$\\s*;`,
    "gi",
  );
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) out.push(m[2]);
  return out;
}

/**
 * Returns ONLY the latest CREATE OR REPLACE body across all migrations.
 * In PostgreSQL the most recent definition wins, so older migrations that
 * were superseded by a fix must not fail this guard.
 */
function latestBody(fnName: string): { file: string; body: string } | null {
  const migs = readAllMigrations();
  for (let i = migs.length - 1; i >= 0; i--) {
    const bodies = extractFunctionBodies(migs[i].sql, fnName);
    if (bodies.length > 0) {
      return { file: migs[i].file, body: bodies[bodies.length - 1] };
    }
  }
  return null;
}

describe("stock adjustment RPC type contracts", () => {
  const migrations = readAllMigrations();

  it("approve_stock_adjustment_atomic posts via post_journal_entry_atomic and never writes a string-prefixed source_id", () => {
    const latest = latestBody("approve_stock_adjustment_atomic");
    expect(latest, "approve_stock_adjustment_atomic must be defined in a migration").not.toBeNull();
    if (!latest) return;
    // ADR 0016 — JE posting MUST go through the canonical writer, not raw INSERT.
    // The matching guard in `inventory-adjustment-posting.test.ts` forbids raw
    // INSERT INTO journal_entries inside this RPC; this guard requires the
    // positive: the canonical RPC is actually called.
    const usesCanonicalWriter = /post_journal_entry_atomic\s*\(/i.test(latest.body);
    expect(
      usesCanonicalWriter,
      `${latest.file}: approve_stock_adjustment_atomic must post GL via post_journal_entry_atomic(...) per ADR 0016.`,
    ).toBe(true);
    const rawJEInsert = /INSERT\s+INTO\s+(?:public\.)?journal_entries/i.test(latest.body);
    expect(
      rawJEInsert,
      `${latest.file}: approve_stock_adjustment_atomic must NOT raw-insert into journal_entries — route through post_journal_entry_atomic per ADR 0016.`,
    ).toBe(false);
    const badPrefix =
      /'\s*(?:stock[-_]?adj|adj)[-_][^']*'\s*\|\|\s*p_adjustment_id\s*::\s*text/i;
    expect(
      badPrefix.test(latest.body),
      `${latest.file}: approve_stock_adjustment_atomic writes a string-prefixed value into source_id (uuid). Use the raw uuid p_adjustment_id.`,
    ).toBe(false);
  });

  it("apply_or_request_stock_adjustment casts the adjustment uuid to text for approval_rule_logs.entity_id", () => {
    const latest = latestBody("apply_or_request_stock_adjustment");
    expect(latest, "apply_or_request_stock_adjustment must be defined in a migration").not.toBeNull();
    if (!latest) return;
    const insertsLogs = /INSERT\s+INTO\s+(?:public\.)?approval_rule_logs/i.test(latest.body);
    expect(insertsLogs, `${latest.file} must INSERT INTO approval_rule_logs`).toBe(true);
    const hasCorrectCast = /v_adjustment_id\s*::\s*text/i.test(latest.body);
    expect(
      hasCorrectCast,
      `${latest.file}: apply_or_request_stock_adjustment must cast v_adjustment_id::text when inserting into approval_rule_logs.entity_id (a text column).`,
    ).toBe(true);
  });
});

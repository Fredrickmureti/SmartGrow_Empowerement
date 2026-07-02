/**
 * Stage 3 — Commit safety regression test.
 *
 * Asserts that the latest migration definition of `process_pos_transaction`:
 *   1. Persists an immutable `snapshot` jsonb on every commit (so reprints
 *      and audits read the snapshot, not live product/template joins).
 *   2. Rejects a paid sale (`p_transaction_type='sale'`, `p_total > 0`) with
 *      an empty payments array — preventing the "phantom partial" bug where
 *      the RPC would silently mark the row partial with zero tender.
 *   3. Still honours the idempotency-key short-circuit (Stage 3 keeps the
 *      previously-shipped behaviour intact — duplicate calls return the
 *      original row).
 *
 * This is a structural test against the migration SQL — it does not boot
 * Postgres. The migration file IS the source of truth that ships to prod;
 * if a future agent removes any of these guards, this test fails.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function latestProcessPosTransactionDef(): string {
  const dir = "supabase/migrations";
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  // Walk newest-first; take the last file that defines the function.
  for (let i = files.length - 1; i >= 0; i--) {
    const sql = readFileSync(join(dir, files[i]), "utf8");
    if (/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.process_pos_transaction\s*\(/i.test(sql)) {
      return sql;
    }
  }
  throw new Error("No migration defines process_pos_transaction");
}

describe("Stage 3 — process_pos_transaction commit safety", () => {
  const def = latestProcessPosTransactionDef();

  it("persists a snapshot column on every commit", () => {
    expect(def).toMatch(/v_snapshot\s+jsonb/);
    expect(def).toMatch(/jsonb_build_object\([^)]*'committed_at'/s);
    // INSERT must include the snapshot column AND the v_snapshot value.
    expect(def).toMatch(/idempotency_key,\s*snapshot/);
    expect(def).toMatch(/p_idempotency_key,\s*v_snapshot/);
  });

  it("rejects a paid sale with no payments (no_payments guard)", () => {
    expect(def).toMatch(/'no_payments'/);
    expect(def).toMatch(/jsonb_array_length\(p_payments\)\s*=\s*0/);
  });

  it("retains the idempotency-key short-circuit", () => {
    expect(def).toMatch(/idempotent_replay/);
    expect(def).toMatch(/AND idempotency_key = p_idempotency_key/);
  });

  it("still requires a register branch context", () => {
    expect(def).toMatch(/Register has no branch context/);
  });
});

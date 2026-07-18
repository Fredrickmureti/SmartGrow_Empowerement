/**
 * Phase 3 · Batch T1 architecture guard (ADR 0082 D1).
 *
 * `process_pos_transaction` must be server-authoritative for money math:
 *   - it calls the `pos_resolve_line` helper per line,
 *   - it aggregates a server-side subtotal / tax / total,
 *   - it persists the server totals onto `pos_transactions` (not the
 *     client-supplied `p_subtotal` / `p_tax_amount` / `p_total`),
 *   - it enforces `price_override_required` when a client-supplied price
 *     deviates from the catalog without a manager override.
 *
 * These assertions read the latest migration that defines the function
 * and fail loudly if a future migration regenerates the RPC without
 * preserving the invariant.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

function latestProcessPosTransactionMigration(): string {
  const out = execSync(
    "rg -l 'CREATE OR REPLACE FUNCTION public.process_pos_transaction' supabase/migrations",
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .sort();
  const last = out[out.length - 1];
  if (!last) throw new Error("no migration defines process_pos_transaction");
  return last;
}

describe("POS architecture guard — server-authoritative money math (T1)", () => {
  const file = latestProcessPosTransactionMigration();
  const sql = readFileSync(file, "utf8");
  // Isolate the latest function body to avoid matching earlier defs in
  // the same file.
  const idx = sql.lastIndexOf(
    "CREATE OR REPLACE FUNCTION public.process_pos_transaction",
  );
  const body = sql.slice(idx);

  it("invokes the pos_resolve_line resolver per line", () => {
    expect(body).toMatch(/pos_resolve_line\s*\(/);
  });

  it("aggregates server-side totals (v_srv_subtotal, v_srv_total_tax, v_srv_total)", () => {
    expect(body).toMatch(/v_srv_subtotal/);
    expect(body).toMatch(/v_srv_total_tax/);
    expect(body).toMatch(/v_srv_total\b/);
  });

  it("persists server totals (not p_subtotal / p_tax_amount / p_total) into pos_transactions", () => {
    // Look for the INSERT INTO public.pos_transactions VALUES tuple and
    // confirm it uses v_srv_* rather than the p_* client params for the
    // financial columns.
    const insertMatch = body.match(
      /INSERT\s+INTO\s+public\.pos_transactions[\s\S]*?RETURNING\s+id\s+INTO\s+v_transaction_id/i,
    );
    expect(
      insertMatch,
      "could not locate INSERT INTO pos_transactions in the RPC body",
    ).not.toBeNull();
    const stmt = insertMatch![0];
    expect(stmt).toMatch(/v_srv_subtotal/);
    expect(stmt).toMatch(/v_srv_total_tax/);
    expect(stmt).toMatch(/v_srv_total\b/);
    // The client-supplied totals must NOT appear in the VALUES tuple.
    expect(stmt).not.toMatch(/,\s*p_subtotal\s*,/);
    expect(stmt).not.toMatch(/,\s*p_tax_amount\s*,/);
    expect(stmt).not.toMatch(/,\s*p_total\s*,/);
  });

  it("raises price_override_required when a client price deviates without a manager override", () => {
    expect(body).toMatch(/price_override_required/);
  });

  it("consumes the manager override when one authorises a deviation", () => {
    expect(body).toMatch(
      /UPDATE\s+public\.pos_manager_overrides[\s\S]*consumed_at\s*=\s*now\(\)/i,
    );
  });

  it("keeps the R12 branch-caller assertion in place", () => {
    expect(body).toMatch(/assert_pos_caller_branch_access\s*\(/);
  });
});

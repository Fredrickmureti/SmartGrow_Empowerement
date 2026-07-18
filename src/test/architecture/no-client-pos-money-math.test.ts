/**
 * Architecture guard — Phase 3 · Batch T7 (money math contract).
 *
 * The wire contract of `process_pos_transaction` is server-authoritative:
 *   - the RPC returns a `server_totals` object AND a `total_matches_server`
 *     boolean so clients can diff and surface a warning when the client's
 *     projection disagreed with the server,
 *   - the persisted row on `pos_transactions` is written from the server
 *     aggregate, never from the client's `p_subtotal / p_tax_amount / p_total`.
 *
 * This complements `pos-server-authoritative-money-math.test.ts` by pinning
 * the response schema (rather than the aggregation logic) so a future
 * migration that regenerates the RPC can't silently drop the reconciliation
 * fields the shell and audit tooling rely on.
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

describe("POS money math — client-supplied totals are advisory only", () => {
  const sql = readFileSync(latestProcessPosTransactionMigration(), "utf8");

  it("returns a server_totals object", () => {
    expect(sql).toMatch(/'server_totals'\s*,\s*jsonb_build_object/);
  });

  it("returns a total_matches_server reconciliation flag", () => {
    expect(sql).toMatch(/'total_matches_server'/);
  });

  it("persists server-computed subtotal / tax / total, not client-supplied", () => {
    // The INSERT into pos_transactions must reference the server aggregate
    // variables (v_server_subtotal / v_server_tax / v_server_total), not the
    // raw client parameters (p_subtotal / p_tax_amount / p_total).
    const insertMatch = sql.match(
      /INSERT INTO public\.pos_transactions[\s\S]*?RETURNING/i,
    );
    expect(insertMatch, "process_pos_transaction must INSERT pos_transactions").toBeTruthy();
    const body = insertMatch![0];
    expect(body).toMatch(/v_(?:server_|srv_)?subtotal/);
    expect(body).toMatch(/v_(?:server_|srv_)?(?:total_)?tax/);
    expect(body).toMatch(/v_(?:server_|srv_)?total\b/);
    // Client-supplied money params must not be persisted verbatim.
    expect(body).not.toMatch(/\bp_subtotal\b/);
    expect(body).not.toMatch(/\bp_tax_amount\b/);
    expect(body).not.toMatch(/\bp_total\b/);
  });
});
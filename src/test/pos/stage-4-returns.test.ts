/**
 * Stage 4 — Returns engine regression test (closeout).
 *
 * Structural test against the migration SQL that defines the latest
 * `process_pos_return`. Asserts the four enterprise guards are present:
 *
 *   1. Over-return is rejected via `v_pos_returnable_qty` ('over_return').
 *   2. Returning a voided original is rejected ('original_voided').
 *   3. A return reason is required per line ('missing_reason' /
 *      'invalid_reason') and free-text notes are only allowed when the
 *      reason demands it ('reason_note_required' / 'reason_note_not_allowed').
 *   4. Cross-tender refunds require an authenticated, recent
 *      `cross_tender_refund` manager override row
 *      ('cross_tender_requires_override' / 'invalid_override').
 *
 * Plus a UI guard: the `usePOSReturns` hook forwards `override_id` to the
 * RPC, so the Dialog's manager-PIN flow actually binds to the audit row.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function latestDef(fnName: string): string {
  const dir = "supabase/migrations";
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const sql = readFileSync(join(dir, files[i]), "utf8");
    const re = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fnName}\\s*\\(`, "i");
    if (re.test(sql)) return sql;
  }
  throw new Error(`No migration defines ${fnName}`);
}

describe("Stage 4 — process_pos_return enterprise guards", () => {
  const def = latestDef("process_pos_return");

  it("rejects over-returns via v_pos_returnable_qty", () => {
    expect(def).toMatch(/v_pos_returnable_qty/);
    expect(def).toMatch(/'over_return'/);
  });

  it("blocks returns of voided originals", () => {
    expect(def).toMatch(/'original_voided'/);
    expect(def).toMatch(/v_original_status\s*=\s*'voided'/);
  });

  it("requires a valid reason per line and gates free-text notes", () => {
    expect(def).toMatch(/'missing_reason'/);
    expect(def).toMatch(/'invalid_reason'/);
    expect(def).toMatch(/'reason_note_required'/);
    expect(def).toMatch(/'reason_note_not_allowed'/);
    expect(def).toMatch(/pos_return_reasons/);
  });

  it("enforces cross-tender refunds via a manager override", () => {
    expect(def).toMatch(/p_override_id\s+uuid\s+DEFAULT\s+NULL/i);
    expect(def).toMatch(/'cross_tender_requires_override'/);
    expect(def).toMatch(/'invalid_override'/);
    expect(def).toMatch(/override_type\s*=\s*'cross_tender_refund'/);
    // Override must be recent — guards against stale approvals being reused.
    expect(def).toMatch(/now\(\)\s*-\s*interval\s*'15 minutes'/);
  });

  it("normalizes store_credit refunds to the voucher tender", () => {
    expect(def).toMatch(/p_refund_method\s*=\s*'store_credit'/);
    expect(def).toMatch(/'voucher'/);
  });

  it("links the override audit row back to the new return transaction", () => {
    expect(def).toMatch(/UPDATE\s+public\.pos_manager_overrides[\s\S]*transaction_id\s*=\s*v_transaction_id/i);
  });
});

describe("Stage 4 — usePOSReturns wiring", () => {
  const hook = readFileSync("src/hooks/pos/usePOSReturns.ts", "utf8");
  const dialog = readFileSync("src/components/pos/ReturnDialog.tsx", "utf8");

  it("usePOSReturns forwards override_id to the RPC", () => {
    expect(hook).toMatch(/override_id\?\s*:\s*string\s*\|\s*null/);
    expect(hook).toMatch(/p_override_id:\s*data\.override_id/);
  });

  it("ReturnDialog detects cross-tender from original payments", () => {
    expect(dialog).toMatch(/usePOSOriginalPayments/);
    expect(dialog).toMatch(/isCrossTender/);
    expect(dialog).toMatch(/cross_tender_refund/);
  });

  it("ReturnDialog passes the override id back into executeReturn", () => {
    expect(dialog).toMatch(/executeReturn\(result\.overrideId\)/);
  });
});

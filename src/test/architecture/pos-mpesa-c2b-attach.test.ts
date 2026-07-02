import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Architecture guarantees for the cashier-pull M-Pesa C2B → POS attach flow.
 * These don't hit the DB; they assert the wiring is in place so the cashier
 * actually has a path from "customer paid via paybill" to "sale closes".
 */
describe("POS ↔ M-Pesa C2B attach wiring", () => {
  const root = resolve(__dirname, "../..", "..");

  it("ships the cashier lookup hook, modal and PaymentDialog button", () => {
    const hook = readFileSync(resolve(root, "src/hooks/pos/useMpesaC2BLookup.ts"), "utf8");
    const modal = readFileSync(resolve(root, "src/components/pos/MpesaC2BLookupModal.tsx"), "utf8");
    const dialog = readFileSync(resolve(root, "src/components/pos/PaymentDialog.tsx"), "utf8");

    // Hook calls the secured RPC, not arbitrary table writes.
    expect(hook).toMatch(/attach_c2b_to_pos_transaction/);
    expect(hook).toMatch(/is_reconciled/);

    // Modal is wired to the hook and renders unmatched receipts.
    expect(modal).toMatch(/useMpesaC2BLookup/);
    expect(modal).toMatch(/Look up M-Pesa payment/);

    // PaymentDialog exposes the lookup as a sibling of STK push.
    expect(dialog).toMatch(/MpesaC2BLookupModal/);
    expect(dialog).toMatch(/Look up M-Pesa/);
    expect(dialog).toMatch(/Send STK Push/);
  });

  it("c2b confirmation handler attempts POS auto-match before storing", () => {
    // Post-consolidation: mpesa-c2b-confirmation is now the /confirmation
    // branch of the consolidated mpesa-c2b function.
    const fn = readFileSync(
      resolve(root, "supabase/functions/mpesa-c2b/index.ts"),
      "utf8",
    );
    expect(fn).toMatch(/matched_pos_transaction_id/);
    expect(fn).toMatch(/pos_transactions/);
    expect(fn).toMatch(/pos_transaction_payments/);
    // The auto-match must be gated on "no invoice match" to keep invoice
    // priority behavior.
    expect(fn).toMatch(/if \(!matchedInvoiceId\)/);
    // And the router must dispatch to it.
    expect(fn).toMatch(/case "confirmation":/);
  });

  it("attach RPC migration exists with SECURITY DEFINER + business access check", () => {
    const fs = require("node:fs");
    const dir = resolve(root, "supabase/migrations");
    const files = fs.readdirSync(dir) as string[];
    const matches = files.filter((f) => {
      const p = resolve(dir, f);
      if (!existsSync(p)) return false;
      const sql = readFileSync(p, "utf8");
      return sql.includes("attach_c2b_to_pos_transaction")
        && sql.includes("SECURITY DEFINER")
        && sql.includes("user_has_business_access");
    });
    expect(matches.length).toBeGreaterThan(0);
  });
});

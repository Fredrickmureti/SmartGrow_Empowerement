/**
 * Architecture guard — ADR 0130 Phase 5.5.
 *
 * Every reversible document declared in the canonical registry must be a
 * document type the reversal intent authority understands, and no module may
 * fork the reason vocabulary with a screen-local list. Both are static checks
 * against source, so drift fails CI rather than surfacing as a runtime
 * "does not know document type" error in front of an operator.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { REVERSIBLE_DOCUMENTS } from "@/services/reversal/registerModules";

const ROOT = resolve(__dirname, "../../../");

/** Document types the intent dispatcher and its module resolvers cover. */
const INTENT_DOCUMENT_TYPES = new Set([
  // resolve_reversal_intent_finance
  "invoice",
  "payment",
  "customer_refund",
  "bill",
  "bill_payment",
  "goods_receipt",
  // resolve_reversal_intent_vendor_credit_note (ADR 0132 Phase 4)
  "vendor_credit_note",
  // resolve_reversal_intent_pos / _payroll (Phase 5.5)
  "pos_transaction",
  "payroll_run",
]);

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
};

describe("reversal intent coverage", () => {
  it("every registered reversible document is known to the intent authority", () => {
    for (const doc of REVERSIBLE_DOCUMENTS) {
      expect(
        INTENT_DOCUMENT_TYPES.has(doc.documentType),
        `${doc.documentType} is registered as reversible but the intent authority does not resolve it`,
      ).toBe(true);
    }
  });

  it("the client reason-code union covers POS and payroll", () => {
    const src = readFileSync(
      join(ROOT, "src/components/reversal/useReversalReasonCodes.ts"),
      "utf8",
    );
    expect(src).toContain('"pos_transaction"');
    expect(src).toContain('"payroll_run"');
    expect(src).toContain('"vendor_credit_note"');
  });

  it("no reversal dialog hard-codes a reason list", () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "src"))) {
      if (file.includes("/test/") || file.includes("__tests__")) continue;
      if (file.endsWith("useReversalReasonCodes.ts")) continue;
      // Documented exemption (ADR 0130): the POS command taxonomy in
      // `src/services/pos/reversal/reasonCodes.ts` is a persisted, per-command
      // vocabulary with its own accounting mapping. It maps INTO the governance
      // reason list; it is not a screen-local fork. No other file may declare
      // reversal reason codes.
      if (file.endsWith("services/pos/reversal/reasonCodes.ts")) continue;
      // Documented exemption: `PURCHASE_RETURN_REASON_CODES` is the *return*
      // taxonomy (why goods went back to a vendor), not a reversal reason
      // vocabulary. It never feeds `assert_reversal_reason`.
      if (file.endsWith("lib/purchases/purchaseReturnRpcs.ts")) continue;
      const src = readFileSync(file, "utf8");
      // A local array literal of reason codes is the drift we ban; the codes
      // must come from `reversal_reason_codes` via the shared hook.
      if (
        /(REASON_CODES|REVERSAL_REASONS)\s*(:|=)\s*\[/.test(src) &&
        !src.includes("useReversalReasonCodes")
      ) {
        offenders.push(file.replace(`${ROOT}/`, ""));
      }
    }
    expect(offenders, `hard-coded reversal reason lists: ${offenders.join(", ")}`).toEqual([]);
  });
});

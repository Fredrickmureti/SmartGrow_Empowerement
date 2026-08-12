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

/**
 * Server truth, not a hand-kept constant.
 *
 * The previous version of this guard compared the registry against a literal
 * set maintained by hand — which is how `expense` and `customer_refund` came to
 * be listed as covered while `resolve_reversal_intent` raised "does not know
 * document type" for both. The set is now derived from the migration history:
 * a document type counts as covered only when a resolver function or a
 * dispatcher branch for it exists in SQL.
 */
const MIGRATIONS = join(ROOT, "supabase/migrations");

const intentDocumentTypes = (): Set<string> => {
  const covered = new Set<string>();
  for (const file of readdirSync(MIGRATIONS)) {
    if (!file.endsWith(".sql")) continue;
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    // Dedicated resolver: resolve_reversal_intent_<document_type>(
    for (const m of sql.matchAll(
      /FUNCTION\s+public\.resolve_reversal_intent_([a-z_]+)\s*\(/gi,
    )) {
      covered.add(m[1].toLowerCase());
    }
    // Branches inside a resolver: _document_type = 'invoice'
    if (/resolve_reversal_intent/i.test(sql)) {
      for (const m of sql.matchAll(/_document_type\s*=\s*'([a-z_]+)'/gi)) {
        covered.add(m[1].toLowerCase());
      }
    }
  }
  return covered;
};

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
    const covered = intentDocumentTypes();
    for (const doc of REVERSIBLE_DOCUMENTS) {
      expect(
        covered.has(doc.documentType),
        `${doc.documentType} is registered as reversible but no resolve_reversal_intent branch or resolver exists for it`,
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
    expect(src).toContain('"expense"');
  });

  it("expense voids enter through the reversal sheet, not a menu item", () => {
    const page = readFileSync(join(ROOT, "src/pages/Expenses.tsx"), "utf8");
    expect(page).toContain("VoidExpenseDialog");
    // The confirm path must carry a reason code; a bare voidExpense(id) call is
    // the drift this guard bans.
    expect(/voidExpense\(\s*[A-Za-z.]+\s*\)/.test(page)).toBe(false);
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
      // Same documented exemption: `VENDOR_CREDIT_REASON_CODES` is the reason a
      // supplier issued a credit (damaged, short delivery, price dispute), a
      // commercial taxonomy stored on the credit note. It never feeds
      // `assert_reversal_reason`; reversing that credit note uses the shared
      // vocabulary through `useReversalReasonCodes`.
      if (file.endsWith("credit-notes/vendorCreditNoteLineage.ts")) continue;
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

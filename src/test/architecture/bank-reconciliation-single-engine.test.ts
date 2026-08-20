/**
 * The bank reconciliation statement has ONE engine.
 *
 * `public.finance_bank_reconciliation_statement` computes the bank-to-book
 * proof. The screen (`src/services/finance/bankReconciliationStatement.ts` →
 * `src/pages/reports/BankReconciliationReport.tsx`) is a renderer of that
 * payload.
 *
 * The defect this guard exists to prevent: a screen that re-derives the proof
 * from whatever rows the browser happens to have fetched. The client cannot
 * see every statement line or posted line (row limits), cannot know which
 * entries are already matched, and cannot detect a shared ledger account — so
 * any browser-side arithmetic produces a statement that quietly disagrees with
 * the ledger.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const SERVICE = read("src/services/finance/bankReconciliationStatement.ts");
const PAGE = read("src/pages/reports/BankReconciliationReport.tsx");

describe("bank reconciliation — one engine, one renderer", () => {
  it("routes the statement through the server engine", () => {
    expect(SERVICE).toContain("finance_bank_reconciliation_statement");
  });

  it("keeps the page a consumer: the service is the only RPC caller", () => {
    expect(PAGE).not.toContain("finance_bank_reconciliation_statement\"");
    expect(PAGE).toContain("fetchBankReconciliationStatement");
  });

  it("does not re-derive the proof in the browser", () => {
    // No adjusted balances, no residual, no outstanding-item classification.
    // A JSX prop pass-through (`residual={statement.residual}`) is a handover
    // of the engine's number, not a derivation, so it is allowed.
    expect(PAGE).not.toMatch(/adjustedBank\s*=/);
    expect(PAGE).not.toMatch(/residual\s*=\s*(?![{=])/);
    expect(PAGE).not.toMatch(/statementBalance\s*[+\-]\s*/);
    expect(PAGE).not.toContain("is_reconciled");
    expect(PAGE).not.toContain("journal_entry_lines");
  });

  it("renders the engine's residual explanations instead of inventing causes", () => {
    const EXPLAINER = readFileSync(
      resolve(process.cwd(), "src/components/reports/ResidualExplainer.tsx"),
      "utf8",
    );
    expect(PAGE).toContain("residualExplanations");
    // The explainer only renders what the engine ranked: no local heuristics.
    expect(EXPLAINER).not.toContain("supabase");
    expect(EXPLAINER).not.toMatch(/duplicate_opening_balance|cleared_without_posting/);
    expect(EXPLAINER).not.toMatch(/\.filter\(|\.sort\(/);
  });


  it("surfaces the engine's findings instead of hiding them", () => {
    for (const flag of ["glAccountMissing", "glAccountShared", "inBalance", "clearedWithoutPosting"]) {
      expect(PAGE, `${flag} must be surfaced to the reader`).toContain(flag);
    }
  });

  it("presents both sides of the proof and its residual", () => {
    for (const key of [
      "adjusted_balance",
      "deposits_in_transit",
      "unpresented_payments",
      "unrecorded_receipts",
      "unrecorded_charges",
      "residual",
    ]) {
      expect(SERVICE, `${key} must reach the client`).toContain(key);
    }
  });
});

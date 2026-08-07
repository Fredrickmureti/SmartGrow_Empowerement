import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Phase 4 ratchet — the reversal participants introduced in Phase 4 each have
 * exactly one canonical server-side writer. The client may read their state and
 * ask the server to act; it may never write it.
 *
 *  - warehouse task cancellation belongs to `wms_cancel_tasks_for_document`
 *  - bank reconciliation release belongs to `resolve_reversal_bank_block` /
 *    `unreconcile_bank_transaction`
 *
 * Bypassing either writer re-creates the class of defect ADR 0125/0126/0127
 * eliminated for the ledger: a partially reversed document whose sub-ledger,
 * warehouse queue and bank matching disagree with the general ledger.
 */

const rg = (pattern: string, globs: string[]): string[] => {
  const args = globs.map((g) => `--glob '${g}'`).join(" ");
  try {
    const out = execSync(
      `rg --no-heading --line-number -e ${JSON.stringify(pattern)} ${args} src supabase/functions`,
      { encoding: "utf8" },
    );
    return out.trim().split("\n").filter(Boolean);
  } catch {
    // rg exits 1 when there are no matches.
    return [];
  }
};

const APP_GLOBS = [
  "!**/*.test.ts",
  "!**/*.test.tsx",
  "!src/integrations/supabase/types.ts",
];

describe("Phase 4 reversal writer monopoly", () => {
  it("no application code cancels warehouse tasks directly", () => {
    // `wms_cancel_tasks_for_document` is the only writer that may move an open
    // task to `cancelled`, so a document void and its task cleanup stay in one
    // transaction.
    const offenders = rg(
      String.raw`\.from\(\s*["'`]wms_tasks["'`]\s*\)[\s\S]{0,200}?state:\s*["'`]cancelled["'`]`,
      APP_GLOBS,
    );
    expect(
      offenders,
      "Cancel warehouse tasks through `wms_cancel_tasks_for_document` (called by the canonical void writers), never with a client update.",
    ).toEqual([]);
  });

  it("no client code releases bank reconciliation to unblock a reversal", () => {
    // Clearing the `bank_reconciled` blocker must go through
    // `resolve_reversal_bank_block`, which un-matches exactly the blocking
    // lines and voids the reconciliation journal in one transaction.
    const offenders = [
      ...rg(
        String.raw`\.from\(\s*["'`]bank_reconciliation_matches["'`]\s*\)\s*\.\s*(delete|update|insert|upsert)`,
        APP_GLOBS,
      ),
      ...rg(
        String.raw`\.from\(\s*["'`]bank_transactions["'`]\s*\)[\s\S]{0,200}?(is_reconciled|reconciled_type|reconciled_id)\s*:`,
        APP_GLOBS,
      ),
    ];
    expect(
      offenders,
      "Use `unmatchBankLinesForReversal` (→ `resolve_reversal_bank_block`) or `unreconcile_bank_transaction`; never write reconciliation state from the client.",
    ).toEqual([]);
  });

  it("every reversal surface can resolve the bank blocker it displays", () => {
    // A surface that renders the consequence preview but withholds the
    // un-match action shows the operator a blocker they cannot clear.
    const surfaces = [
      "src/components/invoices/VoidInvoiceDialog.tsx",
      "src/components/bills/VoidBillDialog.tsx",
      "src/components/payments/ReversePaymentWizard.tsx",
      "src/components/bills/BillPaymentHistoryDialog.tsx",
    ];
    const missing = surfaces.filter((file) => {
      const src = readFileSync(file, "utf8");
      return (
        src.includes("<ReversalConsequencePreview") &&
        !src.includes("onUnmatchBankLines=")
      );
    });
    expect(
      missing,
      "Pass `onUnmatchBankLines` (wired to `unmatchBankLinesForReversal`) wherever the consequence preview is rendered.",
    ).toEqual([]);
  });
});

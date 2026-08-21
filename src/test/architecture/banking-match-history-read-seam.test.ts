/**
 * Banking — history explains, it never decides, and it never leaks.
 *
 * Phase 5 of the reconciliation wave added an audit view over
 * `bank_reconciliation_matches`. Two failure modes had to be ratcheted shut:
 *
 *  1. Reading the table straight from the browser. Its SELECT policy was
 *     org-wide, so a history panel would have shown another business's (and
 *     another branch's) reconciliation decisions. History is read through the
 *     scoped RPCs `bank_match_history` / `bank_match_session_history`.
 *  2. An "explain" surface that quietly grows action buttons. Explaining is not
 *     deciding: the history hook must not call any matching or posting seam.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it, expect } from "vitest";

const root = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__snapshots__") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const sourceFiles = walk(join(root, "src"));
const read = (p: string) => readFileSync(join(root, p), "utf8");

const HOOK = "src/hooks/useBankMatchHistory.ts";

/**
 * The only browser modules allowed to select `bank_reconciliation_matches`
 * directly. Both read a *single* row for an operational decision, not history:
 * the open proposal on a line, and whether a recorded payment is already
 * reserved by a match.
 */
const ALLOWED_TABLE_READERS = [
  "src/hooks/useBankPendingMatch.ts",
  "src/hooks/useClearableRecordedPayments.ts",
];

describe("bank match history read seam", () => {
  it("history is read through the scoped RPCs, never the table", () => {
    const hook = read(HOOK);
    expect(hook).toContain("bank_match_history");
    expect(hook).toContain("bank_match_session_history");
    expect(hook).not.toContain('from("bank_reconciliation_matches")');
  });

  it("no new browser module selects bank_reconciliation_matches directly", () => {
    const offenders = sourceFiles
      .filter((f) => !f.endsWith("types.ts"))
      .filter((f) => readFileSync(f, "utf8").includes('from("bank_reconciliation_matches")'))
      .map((f) => relative(root, f).replace(/\\/g, "/"))
      .filter((f) => !ALLOWED_TABLE_READERS.includes(f));
    expect(offenders).toEqual([]);
  });

  it("the history seam takes no decisions", () => {
    const hook = read(HOOK);
    for (const seam of [
      "bank_match_propose",
      "bank_match_confirm",
      "bank_match_reject",
      "bank_match_reverse",
      "unreconcile_bank_transaction",
      "useMutation",
    ]) {
      expect(hook).not.toContain(seam);
    }
  });

  it("the history UI is read-only and consumes only the history hook", () => {
    for (const file of [
      "src/components/banking/BankMatchHistoryPanel.tsx",
      "src/components/banking/BankSessionAuditTrail.tsx",
      "src/components/banking/BankMatchDecisionCard.tsx",
    ]) {
      const source = read(file);
      expect(source).not.toContain("useMutation");
      expect(source).not.toContain(".rpc(");
      expect(source).not.toContain('from("bank_reconciliation_matches")');
    }
  });

  it("the operator can reach a line's history from the reconciliation workspace", () => {
    const page = read("src/pages/BankReconciliation.tsx");
    expect(page).toContain("BankMatchHistoryPanel");
    const tab = read("src/components/banking/ReconciliationHistoryTab.tsx");
    expect(tab).toContain("BankSessionAuditTrail");
  });
});

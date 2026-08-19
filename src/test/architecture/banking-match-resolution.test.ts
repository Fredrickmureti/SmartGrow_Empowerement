/**
 * Banking — a bank line is matched once, and never on a guess.
 *
 * Two defects motivated this ratchet:
 *
 *  1. The reconcile sheet looped `onReconcile` once per selected document, so
 *     banking one deposit against three invoices minted three settlements out
 *     of one bank line. A bank line is a single event: one match, many
 *     allocations.
 *  2. Matching only ever offered "create a new settlement". A receipt that was
 *     already recorded and sitting in Undeposited Funds had no way to be
 *     *cleared*, so operators recorded it twice — once at the till, once at the
 *     bank. `payment` / `bill_payment` allocations exist to clear, and the UI
 *     must be able to reach them.
 *
 * The suggestion side is guarded too: explanations come from the server-side
 * evidence engine (`bank_match_candidates`), never from a client-side scorer
 * and never from the retired `get_reconciliation_match_suggestions`.
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

const SHEET = "src/features/finance/reconciliation/ReconcileTransactionSheet.tsx";

describe("bank match resolution", () => {
  it("the retired suggestion RPC is not called from anywhere", () => {
    const offenders = sourceFiles
      .filter((f) => !f.endsWith("types.ts"))
      .filter((f) => readFileSync(f, "utf8").includes("get_reconciliation_match_suggestions"))
      .map((f) => relative(root, f));
    expect(offenders).toEqual([]);
  });

  it("match explanations come from the server-side evidence engine", () => {
    const hook = read("src/hooks/useBankMatchCandidates.ts");
    expect(hook).toContain("bank_match_candidates");
    // Evidence, not an opaque score, is what the operator is shown.
    expect(hook).toContain("evidence");
  });

  it("the reconcile sheet submits one match, not one per document", () => {
    const sheet = read(SHEET);
    // A loop that awaits the reconcile callback is the duplicate-settlement bug.
    expect(/for\s*\([\s\S]{0,120}?\)\s*\{[\s\S]{0,200}?await\s+onReconcile\(/.test(sheet)).toBe(
      false,
    );
    expect(sheet).toContain("allocations:");
  });

  it("clearing already-recorded money is reachable from the matcher", () => {
    const sheet = read(SHEET);
    expect(sheet).toContain("bill_payment");
    expect(sheet).toContain("payment");
  });

  it("the reconcile write path accepts payment and bill_payment allocations", () => {
    const hook = read("src/hooks/useBankTransactions.ts");
    expect(hook).toContain('"bill_payment"');
    expect(hook).toContain("bank_match_propose");
    expect(hook).toContain("bank_match_confirm");
  });

  it("no client code invents a bank charge by shrinking the document amount", () => {
    // The fee is a named residual passed to the seam; it is never netted off
    // an allocation in the browser.
    const hook = read("src/hooks/useBankTransactions.ts");
    expect(hook).toContain("_fee_amount");
  });
});

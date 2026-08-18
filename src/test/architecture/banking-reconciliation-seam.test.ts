/**
 * Banking Phase 4 — the reconciliation write seam is a monopoly.
 *
 * The reconciliation lifecycle used to be browser-orchestrated: the client
 * inserted the session, toggled cleared items, computed the cleared balance,
 * posted service-charge / interest / write-off journal entries through the
 * client GL helper, bulk-flipped `bank_transactions.is_reconciled` and then
 * marked the session complete. Any failure between those round trips left a
 * half-reconciled bank account, and the client's opening-balance-inclusive
 * `reconciled_balance` disagreed with the stored generated `difference`.
 *
 * Now a single engine owns it:
 *   bank_reconciliation_session_start / _item_set / _session_writeoff /
 *   _session_complete / _session_cancel  (+ bank_transaction_set_category)
 *
 * INSERT/UPDATE/DELETE on bank_reconciliation_sessions / _items and
 * bank_transactions is revoked from `authenticated`, so any direct browser
 * write is a bug that fails here first.
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

function writeCall(table: string): RegExp {
  return new RegExp(
    `\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)\\s*(?:[\\s\\S]{0,400}?)\\.(insert|update|upsert|delete)\\(`,
  );
}

const sourceFiles = walk(join(root, "src"));

describe("bank reconciliation write seam", () => {
  for (const table of ["bank_reconciliation_sessions", "bank_reconciliation_items"]) {
    it(`no application code writes ${table} directly`, () => {
      const pattern = writeCall(table);
      const offenders: string[] = [];
      for (const file of sourceFiles) {
        const src = readFileSync(file, "utf8");
        if (!src.includes(table)) continue;
        if (pattern.test(src)) offenders.push(relative(root, file));
      }
      expect(offenders).toEqual([]);
    });
  }

  it("the session lifecycle runs entirely through the seam RPCs", () => {
    const src = readFileSync(join(root, "src/hooks/useReconciliationSessions.ts"), "utf8");
    for (const fn of [
      "bank_reconciliation_session_start",
      "bank_reconciliation_session_writeoff",
      "bank_reconciliation_session_complete",
      "bank_reconciliation_session_cancel",
    ]) {
      expect(src).toContain(fn);
    }
  });

  it("clearing a statement line is a server call, not a table write", () => {
    const src = readFileSync(join(root, "src/hooks/useReconciliationItems.ts"), "utf8");
    expect(src).toContain("bank_reconciliation_item_set");
    // The browser no longer bulk-stamps reconciliation onto transactions.
    expect(src).not.toContain("markAllReconciled");
    expect(src).not.toContain("is_reconciled: true");
  });

  it("the browser never posts reconciliation journal entries itself", () => {
    for (const file of [
      "src/hooks/useReconciliationSessions.ts",
      "src/components/banking/ReconciliationWorkspace.tsx",
    ]) {
      const src = readFileSync(join(root, file), "utf8");
      expect(src).not.toContain("postToGL");
      expect(src).not.toContain("source_subtype");
    }
  });

  it("the workspace trusts the server's cleared balance and difference", () => {
    const src = readFileSync(
      join(root, "src/components/banking/ReconciliationWorkspace.tsx"),
      "utf8",
    );
    expect(src).toContain("calc.cleared_balance");
    expect(src).toContain("calc.difference");
    expect(src).toContain("calc.is_balanced");
  });

  it("categorizing a bank line goes through the server write seam", () => {
    const pattern = writeCall("bank_transactions");
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("bank_transactions")) continue;
      if (pattern.test(src)) offenders.push(relative(root, file));
    }
    expect(offenders).toEqual([]);

    for (const file of ["src/hooks/useBankTransactions.ts", "src/pages/BankFeeds.tsx"]) {
      expect(readFileSync(join(root, file), "utf8")).toContain(
        "bank_transaction_set_category",
      );
    }
  });
});

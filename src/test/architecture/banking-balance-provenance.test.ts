/**
 * Banking Wave 1 (Phase 7) — balance provenance.
 *
 * Defect D-7: `bank_accounts.current_balance` was a denormalised column that no
 * trigger, RPC or engine maintained, yet the dashboard and banking cards
 * rendered it as cash on hand. A number nobody can trace to a statement line or
 * a posted journal line has no place on a finance screen.
 *
 * Invariants ratcheted here:
 *   1. No application code reads or writes `current_balance` on `bank_accounts`
 *      (the column is dropped; any reference is a regression).
 *   2. Bank balances resolve through the canonical server projection
 *      `bank_account_positions()` exposed by `useBankAccounts`.
 *   3. The resolver reports an unresolvable balance as `null`, not `0` — an
 *      absence, mirroring ADR-0136's rule for missing FX rates.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it, expect } from "vitest";

const root = process.cwd();
const SRC = join(root, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__snapshots__" || entry === "integrations") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(SRC);

/**
 * Lines that read a *bank account* row's balance. The identically named
 * chart-of-accounts column is trigger-maintained and legitimate, so only
 * bank-account expressions and `bank_accounts` selects are offences.
 */
function bankBalanceOffences(): string[] {
  const offences: string[] = [];
  const BANK_EXPR = /\b(bankAccount|bankAcc|bankRow|ba)\.current_balance\b/;
  for (const file of files) {
    const rel = relative(root, file);
    if (rel.startsWith("src/test/")) continue; // fixtures model their own shapes
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!line.includes("current_balance")) return;
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      // A `bank_accounts` select that still asks for the dropped column.
      const isBankSelect =
        /\.select\(/.test(line) &&
        lines.slice(Math.max(0, i - 6), i + 1).some((l) => /from\(["']bank_accounts["']\)/.test(l));
      // A property read off something clearly holding a bank-account row.
      const isBankExpr = BANK_EXPR.test(line) && !/\bgl[A-Za-z]*\./.test(line);
      if (isBankSelect || isBankExpr) offences.push(`${rel}:${i + 1}: ${trimmed}`);
    });
  }
  return offences;
}

describe("banking balance provenance (Phase 7)", () => {
  it("no application code reads the dropped bank_accounts.current_balance column", () => {
    expect(bankBalanceOffences()).toEqual([]);
  });

  it("useBankAccounts resolves balances through bank_account_positions()", () => {
    const src = readFileSync(join(SRC, "hooks/useBankAccounts.ts"), "utf8");
    expect(src).toContain('supabase.rpc(\n        "bank_account_positions"');
    expect(src).toContain("export interface BankAccountPosition");
    expect(src).toContain("export function resolveBankAccountBalance");
  });

  it("an unresolvable bank balance is an absence, never a fabricated zero", () => {
    const src = readFileSync(join(SRC, "hooks/useBankAccounts.ts"), "utf8");
    // The resolver's contract: no position => null.
    expect(src).toMatch(/const p = account\.position;\s*\n\s*if \(!p\) return null;/);
  });

  it("the bank account card renders an em dash when no balance resolves", () => {
    const src = readFileSync(join(SRC, "components/banking/BankAccountCard.tsx"), "utf8");
    expect(src).toContain("resolveBankAccountBalance");
    expect(src).toMatch(/displayBalance == null/);
  });
});

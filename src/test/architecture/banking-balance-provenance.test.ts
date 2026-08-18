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

/** Lines that touch a bank-account row's balance, ignoring `accounts.current_balance`. */
function bankBalanceOffences(): string[] {
  const offences: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    if (!src.includes("current_balance")) continue;
    // Only bank-account contexts matter; the chart-of-accounts column of the
    // same name is trigger-maintained and legitimate.
    const isBankFile =
      /bank_accounts|BankAccount|bankAccount/.test(src) && !/gift_card|GiftCard/.test(src);
    if (!isBankFile) continue;
    src.split("\n").forEach((line, i) => {
      if (!line.includes("current_balance")) return;
      // `accounts` / `glAccount` reads are the CoA column, not the bank row.
      if (/\b(gl|glAcc|glAccount|account|acc)\.(current_balance)/.test(line) && !/bankAccount\./.test(line)) return;
      if (/from\("accounts"\)|\.from\('accounts'\)/.test(line)) return;
      offences.push(`${relative(root, file)}:${i + 1}: ${line.trim()}`);
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

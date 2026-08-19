/**
 * Banking is currency-agnostic (ADR 0136).
 *
 * A bank line is denominated in its bank account's currency and a candidate
 * document in its own. The low-level `@/lib/utils` formatter has no currency
 * default, so a banking surface that imports it is one refactor away from
 * rendering an amount with no currency at all — banking surfaces must go
 * through `useBankMoney`, which resolves the account's currency.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const BANKING_SURFACES = [
  "src/pages/BankReconciliation.tsx",
  "src/pages/BankFeeds.tsx",
  "src/components/banking/TransactionsList.tsx",
  "src/features/finance/reconciliation/ReconcileTransactionSheet.tsx",
  "src/features/finance/reconciliation/TransferReconcileSheet.tsx",
];

describe("banking currency seam", () => {
  it("no banking surface imports the low-level formatter", () => {
    for (const path of BANKING_SURFACES) {
      const src = read(path);
      expect(
        /import\s*\{[^}]*\bformatCurrency\b[^}]*\}\s*from\s*"@\/lib\/utils"/.test(src),
        `${path} must format money through useBankMoney, not @/lib/utils`,
      ).toBe(false);
    }
  });

  it("every banking surface resolves money through useBankMoney", () => {
    for (const path of BANKING_SURFACES) {
      expect(read(path), `${path} must use useBankMoney`).toMatch(/useBankMoney/);
    }
  });

  it("the low-level formatter carries no currency default", () => {
    const utils = read("src/lib/utils.ts");
    expect(utils).not.toMatch(/currency\s*(\?)?\s*:\s*string[^)]*=\s*["']/);
    expect(utils).not.toMatch(/["']USD["']/);
  });

  it("the currency context seeds no literal base currency", () => {
    const ctx = read("src/contexts/CurrencyContext.tsx");
    expect(ctx).not.toMatch(/\|\|\s*["']USD["']/);
    expect(ctx).not.toMatch(/return\s+["']USD["']/);
  });

  it("the transfer sheet offers only same-currency counterparties", () => {
    const sheet = read("src/features/finance/reconciliation/TransferReconcileSheet.tsx");
    expect(sheet).toMatch(/eligibleAccounts/);
    expect(sheet).toMatch(/currency\s*\)\s*===\s*thisCurrency|=== thisCurrency/);
    expect(sheet).toMatch(/Cross-currency transfers are not supported/);
  });

  it("match candidates are blocked when their currency differs", () => {
    const sheet = read("src/features/finance/reconciliation/ReconcileTransactionSheet.tsx");
    expect(sheet).toMatch(/currencyMatches/);
    expect(sheet).toMatch(/cannot settle a/);
  });
});

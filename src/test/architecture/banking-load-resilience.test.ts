import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Guard: banking load paths must go through the resilience seam.
 *
 * Landing on a banking surface used to fire ~6 uncoordinated Supabase calls
 * with no timeout/retry, and the first transport hiccup became a hard
 * "Failed to load transactions" toast. See docs/architecture/RESILIENCE.md.
 */
const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const ACCOUNTS = "src/hooks/useBankAccounts.ts";
const TRANSACTIONS = "src/hooks/useBankTransactions.ts";

describe("banking load resilience", () => {
  it("useBankAccounts loads through safeQueryRetry", () => {
    const src = read(ACCOUNTS);
    expect(src).toContain("safeQueryRetry");
    expect(src).toMatch(/from "@\/services\/resilience"/);
  });

  it("useBankTransactions loads through safeQueryRetry", () => {
    const src = read(TRANSACTIONS);
    expect(src).toContain("safeQueryRetry");
  });

  it("neither hook awaits a bare supabase call on its load path", () => {
    for (const file of [ACCOUNTS, TRANSACTIONS]) {
      const loadPath = read(file).split("const mapPermErr")[0].split("reconcileTransaction = async")[0];
      expect(loadPath).not.toMatch(/await\s+supabase\s*\n?\s*\.from\(/);
      expect(loadPath).not.toMatch(/await\s+supabase\.rpc\(/);
    }
  });

  it("page load failures are state, not toasts", () => {
    for (const file of [ACCOUNTS, TRANSACTIONS]) {
      const src = read(file);
      expect(src).toContain("loadError");
      expect(src).not.toContain('toast.error("Failed to load transactions")');
      expect(src).not.toContain('toast.error("Failed to load bank accounts")');
    }
  });

  it("bank-account loads are deduped so one screen issues one fetch", () => {
    const src = read(ACCOUNTS);
    expect(src).toContain("accountsInflight");
    expect(src).toContain("accountsCache");
  });

  it("banking surfaces render the inline retry panel", () => {
    for (const page of ["src/pages/Banking.tsx", "src/pages/BankFeeds.tsx", "src/pages/BankReconciliation.tsx"]) {
      expect(read(page)).toContain("BankingLoadError");
    }
  });
});

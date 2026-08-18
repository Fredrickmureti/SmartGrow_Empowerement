/**
 * One FX display surface, system-wide (ADR 0136).
 *
 * `describe_exchange_rate` answers "what rate does the book hold for this
 * currency on this date, and where did it come from?". Exactly one module is
 * allowed to ask it — `@/components/finance/ExchangeRatePanel` — so every
 * money-bearing form in Finance, Purchases, Sales and Warehouse shows the same
 * rate, the same provenance line, and the same red missing-rate refusal.
 *
 * A second copy of that query is how surfaces drift apart: one screen blocks a
 * parity posting, its sibling silently allows it. This ratchet forbids the copy.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it, expect } from "vitest";

const root = process.cwd();
const SRC = join(root, "src");
const PANEL = "src/components/finance/ExchangeRatePanel.tsx";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__snapshots__") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(SRC).filter(
  (f) =>
    !/\.test\.(ts|tsx)$/.test(f) &&
    !relative(root, f).startsWith("src/integrations/supabase") &&
    !relative(root, f).startsWith("src/test/"),
);

describe("FX rate display is a single shared surface", () => {
  it("only ExchangeRatePanel calls describe_exchange_rate", () => {
    const offenders = files
      .filter((f) => /rpc\(\s*["']describe_exchange_rate["']/.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f))
      .filter((f) => f !== PANEL);

    expect(
      offenders,
      "these files re-implement the FX describer instead of using ExchangeRatePanel",
    ).toEqual([]);
  });

  it("no surface re-declares the rate-source label map", () => {
    const offenders = files
      .filter((f) => /RATE_SOURCE_LABEL\s*[:=]/.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f))
      .filter((f) => f !== PANEL);

    expect(offenders, "duplicated rate-source labels").toEqual([]);
  });

  it("every currency-picking money form shows rate provenance", () => {
    const FORMS = [
      "src/features/finance/banking/BankAccountCreatePage.tsx",
      "src/features/finance/banking/BankAccountEditPage.tsx",
      "src/features/purchases/landed-costs/LandedCostCreatePage.tsx",
      "src/features/purchases/contracts/ContractCreatePage.tsx",
      "src/features/purchases/expenses/ExpenseFormFields.tsx",
    ];
    for (const form of FORMS) {
      const src = readFileSync(join(root, form), "utf8");
      expect(src, `${form} must render ExchangeRatePanel`).toContain(
        "ExchangeRatePanel",
      );
    }
  });

  it("the shared currency picker carries no currency literal", () => {
    const src = readFileSync(join(root, "src/components/common/CurrencySelect.tsx"), "utf8");
    expect(/["'](USD|EUR|KES|GBP)["']/.test(src)).toBe(false);
  });
});

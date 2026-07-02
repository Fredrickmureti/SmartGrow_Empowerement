/**
 * ADR 0012 R4 — cross-currency refund guard.
 *
 * Until ADR 0015 (FX revaluation on reversal) lands, the wizard MUST
 * block a refund whose bank account currency differs from the business
 * base currency. The block lives in TWO places:
 *   1. UI level — Next is disabled, mismatch message renders.
 *   2. Submit level — hard throw, so a forced submit cannot leak past
 *      the disabled button.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WIZARD = readFileSync(
  join(process.cwd(), "src/components/payments/ReversePaymentWizard.tsx"),
  "utf8",
);

describe("ADR 0012 R4 — cross-currency refund guard", () => {
  it("derives currencyMismatch from the selected bank account vs base currency", () => {
    expect(WIZARD).toMatch(/currencyMismatch/);
    expect(WIZARD).toMatch(/selectedBank[\s\S]{0,30}currency\s*!==\s*baseCurrency/);
  });

  it("submit hard-throws on currency mismatch", () => {
    expect(WIZARD).toMatch(
      /if \(currencyMismatch\)[\s\S]{0,200}throw new Error/,
    );
    expect(WIZARD).toMatch(/Cross-currency refunds are not yet supported/);
  });

  it("UI surfaces the mismatch inline under the bank-account picker", () => {
    expect(WIZARD).toMatch(/currencyMismatch[\s\S]{0,400}Cross-currency refunds/);
  });
});

/**
 * Banking Wave 1 (Phase 5) — currency integrity on the banking surface.
 *
 * Invariants ratcheted here:
 *   1. A bank account's currency is chosen from the canonical catalogue
 *      (`useCurrencies` + `CurrencyCombobox`) — the same picker Landed Cost
 *      uses — never typed as free text, and never narrowed to a private
 *      per-surface list. Rate coverage is answered by `ExchangeRatePanel`,
 *      which shows the resolved rate and its provenance, not by hiding
 *      currencies from the operator.
 *   2. No country-specific bank fixtures live in core Finance (the platform is
 *      country-agnostic; Kenyan Equity/Jenga test accounts were removed).
 *   3. No banking file converts money at a hardcoded 1:1 or a rate literal —
 *      conversion goes through `@/services/fx/rateBook`, and a missing rate is
 *      an absence, not parity (ADR 0136).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it, expect } from "vitest";

const root = process.cwd();
const BANKING_DIR = join(root, "src/features/finance/banking");

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

const bankingFiles = walk(BANKING_DIR);

describe("banking currency integrity (Phase 5)", () => {
  it("bank account create/edit pick currency from the canonical catalogue", () => {
    for (const page of ["BankAccountCreatePage.tsx", "BankAccountEditPage.tsx"]) {
      const src = readFileSync(join(BANKING_DIR, page), "utf8");
      expect(src, `${page} must use CurrencyCombobox`).toContain(
        "CurrencyCombobox",
      );
      expect(src, `${page} must source the canonical catalogue`).toContain(
        "useCurrencies",
      );
      expect(
        src.includes("useBusinessActiveCurrencies"),
        `${page} must not narrow the catalogue to a private active list`,
      ).toBe(false);
      expect(src, `${page} must show rate provenance`).toContain(
        "ExchangeRatePanel",
      );
      // A free-text currency box is the regression this guards.
      expect(
        /<Input[^>]*value=\{currency\}/s.test(src),
        `${page} must not bind a raw <Input> to currency`,
      ).toBe(false);
    }
  });

  it("core banking carries no country-specific bank fixtures", () => {
    const offenders: string[] = [];
    for (const file of bankingFiles) {
      const src = readFileSync(file, "utf8");
      if (/JENGA_TEST_ACCOUNTS|Equity Kenya|"KES"|'KES'/.test(src)) {
        offenders.push(relative(root, file));
      }
    }
    expect(offenders, "country fixtures in core Finance banking").toEqual([]);
  });

  it("banking never values an unknown FX pair at 1:1", () => {
    const offenders: string[] = [];
    for (const file of bankingFiles) {
      const src = readFileSync(file, "utf8");
      if (
        /(exchange_rate|exchangeRate|fx_rate|rate)\s*(\?\?|\|\|)\s*1\b/.test(src) ||
        /COALESCE\(\s*exchange_rate\s*,\s*1\s*\)/i.test(src)
      ) {
        offenders.push(relative(root, file));
      }
    }
    expect(offenders, "1:1 FX fallback in banking").toEqual([]);
  });
});

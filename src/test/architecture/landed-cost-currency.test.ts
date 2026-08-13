/**
 * Landed cost — currency & FX participation guard (ADR 0135 / 0136).
 *
 * Landed cost must be a consumer of the ONE monetary architecture:
 *   - currency comes from the canonical catalogue (`useCurrencies` over
 *     `public.currencies`), never a module-local list or a free-text field;
 *   - the booking rate is stamped server-side; the browser may display a rate
 *     but must never send one or multiply an accounting amount by it;
 *   - no landed-cost-specific FX resolver, and no silent 1:1 fallback.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "src/features/purchases/landed-costs");

const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
  .map((f) => ({ name: f, src: readFileSync(join(DIR, f), "utf8") }));

const CREATE = FILES.find((f) => f.name === "LandedCostCreatePage.tsx")!;

describe("landed cost — canonical currency catalogue", () => {
  it("selects currency through the shared catalogue picker", () => {
    expect(CREATE.src).toContain("useCurrencies");
    expect(CREATE.src).toContain("CurrencyCombobox");
  });

  it("defines no module-local currency list", () => {
    for (const { name, src } of FILES) {
      const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(
        /\[[^\]]*["']USD["'][^\]]*["'](KES|EUR|GBP)["']/.test(code),
        `${name} hardcodes a currency list`,
      ).toBe(false);
      expect(
        /LANDED_COST_CURRENCIES|LandedCostCurrenc/i.test(code),
        `${name} declares a landed-cost currency catalogue`,
      ).toBe(false);
    }
  });

  it("carries no currency literal fallback", () => {
    for (const { name, src } of FILES) {
      const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(
        /\?\?\s*["'](KES|USD|EUR|GBP)["']/.test(code),
        `${name} falls back to a hardcoded currency`,
      ).toBe(false);
    }
  });
});

describe("landed cost — no second FX engine", () => {
  it("declares no landed-cost FX resolver", () => {
    for (const { name, src } of FILES) {
      expect(
        /getLandedCostExchangeRate|convertLandedCostCurrency|landedCostFxRate/i.test(src),
        `${name} implements a landed-cost FX resolver`,
      ).toBe(false);
    }
  });

  it("never sends a booking rate from the browser", () => {
    const code = CREATE.src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(/exchange_rate\s*:/);
    expect(code).not.toMatch(/exchange_rate_date\s*:/);
  });

  it("does not compute a base-currency accounting amount client-side", () => {
    const code = CREATE.src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(/baseTotal/);
    expect(code).not.toMatch(/\*\s*\(?\s*Number\(exchangeRate\)/);
  });

  it("reads rate provenance from the canonical describer only", () => {
    expect(CREATE.src).toContain("describe_exchange_rate");
    for (const { name, src } of FILES) {
      expect(
        /from\(["']platform_exchange_rates["']\)/.test(src),
        `${name} reads platform market data directly`,
      ).toBe(false);
    }
  });
});

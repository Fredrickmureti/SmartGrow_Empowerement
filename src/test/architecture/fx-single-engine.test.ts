/**
 * ADR 0136 — one FX engine, no silent 1:1.
 *
 * Ratchet guard. The browser may DISPLAY a rate; it may never invent one, and
 * there may be exactly one client-side lookup (`@/services/fx/rateBook`).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRateFromBook, convertWithBook, type RateBookRow } from "@/services/fx/rateBook";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const ROWS: RateBookRow[] = [
  { from_currency: "USD", to_currency: "KES", rate: 130, effective_date: "2026-08-01", source: "provider" },
  { from_currency: "USD", to_currency: "KES", rate: 128, effective_date: "2026-08-01", source: "override" },
  { from_currency: "EUR", to_currency: "KES", rate: 140, effective_date: "2026-07-01", source: "provider" },
];

describe("rateBook — the single client lookup", () => {
  it("returns null (never 1) when no rate is on file", () => {
    expect(resolveRateFromBook(ROWS, "JPY", "GBP", "2026-08-12", "KES")).toBeNull();
    expect(convertWithBook(ROWS, 100, "JPY", "GBP", "2026-08-12", "KES")).toBeNull();
  });

  it("returns 1 only for an identical pair", () => {
    expect(resolveRateFromBook(ROWS, "KES", "KES")).toBe(1);
  });

  it("honours source precedence: override beats provider on the same date", () => {
    expect(resolveRateFromBook(ROWS, "USD", "KES", "2026-08-12", "KES")).toBe(128);
  });

  it("ignores rows effective after the as-of date", () => {
    expect(resolveRateFromBook(ROWS, "USD", "KES", "2026-07-15", "KES")).toBeNull();
  });

  it("inverts a reverse pair", () => {
    expect(resolveRateFromBook(ROWS, "KES", "USD", "2026-08-12", "KES")).toBeCloseTo(1 / 128, 10);
  });

  it("triangulates through the base-currency pivot", () => {
    // EUR→KES 140, USD→KES 128  ⇒  EUR→USD = 140/128
    expect(resolveRateFromBook(ROWS, "EUR", "USD", "2026-08-12", "KES")).toBeCloseTo(140 / 128, 10);
  });
});

describe("no parallel client FX engines", () => {
  it("useTenantFx delegates to the shared rate book and reads the accounting book", () => {
    const src = read("src/hooks/useTenantFx.ts");
    expect(src).toMatch(/resolveRateFromBook/);
    expect(src).toMatch(/from\("exchange_rates"\)/);
    expect(src).not.toMatch(/platform_exchange_rates/);
  });

  it("CurrencyContext delegates to the shared rate book", () => {
    const src = read("src/contexts/CurrencyContext.tsx");
    expect(src).toMatch(/resolveRateFromBook/);
  });

  it("tenant-entered rates are written as overrides, never as provider rows", () => {
    const src = read("src/contexts/CurrencyContext.tsx");
    expect(src).toMatch(/source:\s*"override"/);
  });

  it("useAdminCurrency carries no hardcoded rate literal and no silent 1 fallback", () => {
    const src = read("src/hooks/useAdminCurrency.ts");
    expect(src).not.toMatch(/129\.5/);
    expect(src).toMatch(/usdToTargetRate[\s\S]{0,900}return null;/);
  });
});

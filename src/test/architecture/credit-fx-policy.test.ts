/**
 * Wave 8 guard — credit FX policy & per-currency presentation.
 *
 * Two regressions to prevent:
 *   1. base_credit_amount falling back to a 1:1 copy of balance (ignoring
 *      foreign currency).
 *   2. The per-currency view disappearing or losing the currency dimension.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("credit FX policy & per-currency presentation", () => {
  const migrations = read("supabase/migrations/20260812000001_wave8_per_currency_fx.sql");

  it("defines the to_base_amount FX conversion function", () => {
    expect(migrations).toContain("CREATE OR REPLACE FUNCTION public.to_base_amount");
    // Must look up exchange_rates, not hardcode 1.0.
    expect(migrations).toContain("exchange_rates");
    expect(migrations).toContain("from_currency");
    expect(migrations).toContain("to_currency");
    expect(migrations).toContain("base_currency");
  });

  it("converts base_credit_amount via to_base_amount, not 1:1", () => {
    const creditDef = migrations.slice(
      migrations.indexOf("CREATE OR REPLACE VIEW public.finance_ar_customer_credit"),
      migrations.indexOf("GRANT SELECT ON public.finance_ar_customer_credit"),
    );
    expect(creditDef).toContain("to_base_amount");
    // The old 1:1 pattern should not be the definition of base_credit_amount.
    expect(creditDef).not.toMatch(/\bbase_credit_amount\b[^;]*ccb\.balance\b(?!.*to_base_amount)/);
  });

  it("creates the per-currency net position view with a currency column", () => {
    const viewDef = migrations.slice(
      migrations.indexOf("finance_ar_net_position_by_currency"),
    );
    expect(viewDef).toContain("a.currency");
    expect(viewDef).toContain("GROUP BY");
    expect(viewDef).toContain("base_net_amount");
    // Aging buckets must be in document currency (amt), not base_amt.
    expect(viewDef).toContain("AS not_due");
  });
});

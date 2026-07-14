/**
 * ADR-0062 runtime contract: `sum_gross_amount` must report true gross
 * earnings from `payslips.gross_pay`, *independent* of `sum_taxable_amount`.
 *
 * Fixture uses the exact numbers from the 2026-07-14 accountant report:
 *   basic 80,000 + housing 9,000 + transport 5,000 = gross 94,000
 *   gross 94,000 − NSSF 5,640 − SHIF 2,585 − AHL 1,410 = taxable 84,365.06
 * (0.06 kept for rounding parity with the engine).
 */
import { describe, it, expect } from "vitest";
import {
  readSource,
  isKnownSource,
  isNumericSource,
  STATIC_SYSTEM_SOURCES,
  type SourceContext,
} from "../../../supabase/functions/_shared/returnSourceResolver";

const ctx: SourceContext = {
  employee: { first_name: "Asha", last_name: "Mwangi" },
  sums: {
    employee: 9_635,     // employee statutory contributions total
    employer: 4_935,     // employer statutory contributions total
    gross: 94_000,       // basic + housing + transport
    taxable: 84_365.06,  // gross − pre-tax NSSF+SHIF+AHL
    basic: 80_000,
    allowances: 14_000,
    payslipCount: 1,
    byRule: {},
    byComponent: {},
    byColumn: {},
  },
};

describe("ADR-0062 — sum_gross_amount is a first-class canonical source", () => {
  it("is exported as a static system source", () => {
    expect(STATIC_SYSTEM_SOURCES).toContain("sum_gross_amount");
    expect(isKnownSource("sum_gross_amount")).toBe(true);
    expect(isNumericSource("sum_gross_amount")).toBe(true);
  });

  it("returns gross_pay (94,000), NOT taxable_income (84,365.06)", () => {
    expect(readSource("sum_gross_amount", ctx)).toBe(94_000);
    expect(readSource("sum_taxable_amount", ctx)).toBe(84_365.06);
    // The two are distinct values on this fixture.
    expect(readSource("sum_gross_amount", ctx)).not.toBe(
      readSource("sum_taxable_amount", ctx),
    );
  });

  it("gross ≠ basic + allowances (protects against sum_basic+sum_allowances substitution)", () => {
    // Substituting sum_basic + sum_allowances for gross is the tempting
    // wrong fix — it silently omits overtime, bonus, commission and
    // taxable reimbursements. On this fixture they happen to coincide,
    // but the runtime source must be gross_pay directly.
    const gross = readSource("sum_gross_amount", ctx) as number;
    // Bump reimbursements to prove gross is not a derived sum.
    const ctxWithReimb: SourceContext = {
      ...ctx,
      sums: { ...ctx.sums, gross: ctx.sums.gross + 1_500 },
    };
    expect(readSource("sum_gross_amount", ctxWithReimb)).toBe(gross + 1_500);
    // sum_basic + sum_allowances stays flat because they read separate fields.
    expect(readSource("sum_basic_pay", ctxWithReimb)).toBe(80_000);
    expect(readSource("sum_allowances", ctxWithReimb)).toBe(14_000);
  });
});

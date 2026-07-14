/**
 * Phase B follow-up — pins the runtime contract of the shared source resolver
 * used by generate-statutory-return, govFileWriter, and xmlWriter. If this
 * test goes red, pack-driven return numbers move silently — treat any failure
 * as a payroll-compliance regression.
 *
 * Rule codes used as fixtures (`rule_a/b/c/d`, `relief_x/y`) are intentionally
 * neutral. The resolver is country-agnostic and accepts any pack-defined rule
 * code; baking country-specific names (NSSF/SHIF/PAYE/…) into this contract
 * would falsely couple core to the Kenya pack.
 */
import { describe, it, expect } from "vitest";
import {
  readSource,
  extractExtraRuleCodes,
  isKnownSource,
  isNumericSource,
  type SourceContext,
} from "../../../supabase/functions/_shared/returnSourceResolver";

function makeCtx(overrides: Partial<SourceContext["sums"]> = {}): SourceContext {
  return {
    employee: { first_name: "Asha", last_name: "Mwangi", tax_id: "TID-001", stat_id_1: "SID-7", nssf_number: "NSSF-42" },
    sums: {
      employee: 12_500,
      employer: 4_320,
      gross: 105_000,
      taxable: 100_000,
      basic: 80_000,
      allowances: 20_000,
      payslipCount: 3,
      byRule: {
        rule_a: { employee: 12_500, employer: 0 },
        rule_b: { employee: 4_320, employer: 4_320 },
        rule_c: { employee: 2_750, employer: 0 },
        rule_d: { employee: 1_500, employer: 1_500 },
        relief_x: { employee: 2_400, employer: 0 },
        relief_y: { employee: 500, employer: 0 },
      },
      ...overrides,
    },
  };
}

describe("returnSourceResolver — system sources", () => {
  const ctx = makeCtx();

  it("reads employee.<key>", () => {
    expect(readSource("employee.tax_id", ctx)).toBe("TID-001");
    expect(readSource("employee.stat_id_1", ctx)).toBe("SID-7");
    expect(readSource("employee.statutory_id.nssf", ctx)).toBe("NSSF-42");
    expect(readSource("employee.full_name", ctx)).toBe("Asha Mwangi");
    expect(readSource("employee.missing", ctx)).toBe("");
  });

  it("reads sum_* totals rounded to 2dp", () => {
    expect(readSource("sum_employee_amount", ctx)).toBe(12500);
    expect(readSource("sum_employer_amount", ctx)).toBe(4320);
    expect(readSource("sum_gross_amount", ctx)).toBe(105000);
    expect(readSource("sum_taxable_amount", ctx)).toBe(100000);
    expect(readSource("sum_basic_pay", ctx)).toBe(80000);
    expect(readSource("sum_allowances", ctx)).toBe(20000);
    expect(readSource("sum_total_amount", ctx)).toBe(16820);
    expect(readSource("count_payslips", ctx)).toBe(3);
  });

  it("reads constants and unknown sources", () => {
    expect(readSource("constant.RESIDENT", ctx)).toBe("RESIDENT");
    expect(readSource("totally_unknown", ctx)).toBe("");
  });
});

describe("returnSourceResolver — per-rule sums", () => {
  it("reads sum_rule.<code>.employee/employer for arbitrary pack-defined codes", () => {
    const ctx = makeCtx();
    expect(readSource("sum_rule.rule_b.employee", ctx)).toBe(4320);
    expect(readSource("sum_rule.rule_b.employer", ctx)).toBe(4320);
    expect(readSource("sum_rule.rule_c.employee", ctx)).toBe(2750);
    expect(readSource("sum_rule.rule_d.employee", ctx)).toBe(1500);
  });

  it("returns 0 for an unreferenced rule (no silent crash)", () => {
    const ctx = makeCtx();
    expect(readSource("sum_rule.never_seen.employee", ctx)).toBe(0);
  });

  it("reads internally-bound return column values before string-source fallback", () => {
    const ctx = makeCtx({ byColumn: { voluntary: 2000 } });
    expect(readSource("bound_column.voluntary", ctx)).toBe(2000);
    expect(readSource("bound_column.missing", ctx)).toBe("");
  });
});

describe("returnSourceResolver — taxable minus pre-tax deductions", () => {
  it("subtracts an arbitrary list of pack-defined pre-tax rule codes", () => {
    const ctx = makeCtx();
    // 100000 − 4320 − 2750 − 1500 = 91430
    expect(readSource("sum_taxable_minus_rules:rule_b,rule_c,rule_d", ctx)).toBe(91430);
  });

  it("ignores unknown rule codes (treats them as 0) so a misspelling does not crash a filing", () => {
    const ctx = makeCtx();
    expect(readSource("sum_taxable_minus_rules:rule_b,typo", ctx)).toBe(95680);
  });
});

describe("returnSourceResolver — discovery and recognition", () => {
  it("extractExtraRuleCodes pulls every code referenced by columns", () => {
    const codes = extractExtraRuleCodes([
      "employee.tax_id",
      "sum_employee_amount",
      "sum_rule.rule_b.employee",
      "sum_rule.rule_c.employee",
      "sum_taxable_minus_rules:rule_b,rule_c,rule_d",
      "sum_rule.relief_x.employee",
    ]);
    expect(codes.sort()).toEqual(
      ["relief_x", "rule_b", "rule_c", "rule_d"].sort(),
    );
  });

  it("isKnownSource accepts the country-agnostic patterns", () => {
    expect(isKnownSource("sum_rule.x.employee")).toBe(true);
    expect(isKnownSource("sum_rule.x.employer")).toBe(true);
    expect(isKnownSource("sum_taxable_minus_rules:a,b")).toBe(true);
    expect(isKnownSource("employee.de_steuer_id")).toBe(true);
    expect(isKnownSource("employee.statutory_id.nssf")).toBe(true);
    expect(isKnownSource("not_a_real_source")).toBe(false);
  });

  it("isNumericSource recognises every numeric token shape", () => {
    expect(isNumericSource("sum_employee_amount")).toBe(true);
    expect(isNumericSource("sum_gross_amount")).toBe(true);
    expect(isNumericSource("sum_basic_pay")).toBe(true);
    expect(isNumericSource("sum_total_amount")).toBe(true);
    expect(isNumericSource("count_payslips")).toBe(true);
    expect(isNumericSource("sum_rule.rule_b.employer")).toBe(true);
    expect(isNumericSource("sum_taxable_minus_rules:rule_b")).toBe(true);
    expect(isNumericSource("employee.tax_id")).toBe(false);
  });
});
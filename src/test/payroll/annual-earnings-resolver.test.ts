/**
 * annualEarningsResolver — regression guard.
 *
 * Root causes this test locks down (ADR-0091 hardening):
 *
 *   1. RPC column name: `payroll_employee_monthly_breakdown` returns
 *      `month_index`, not `month`. Reading the wrong column silently
 *      zeroed every month and every YTD total.
 *   2. Single-source projection: `months[]` is the canonical writer.
 *      YTD is derived by folding months so the two views cannot drift.
 *   3. Statutory (ER) monthly is fed from `employer_amount`, not
 *      `employee_amount` (which is 0 for those rows). Regressing this
 *      re-zeros the Statutory (ER) column.
 *   4. `post_tax_deduction` (garnishments, court orders) is routed into
 *      `other_deductions` — silently dropping it under-reports both
 *      monthly and YTD.
 *   5. Determinism: two resolves with identical inputs must produce an
 *      identical `provenance.content_hash`.
 */
import { describe, it, expect } from "vitest";
import { resolveAnnualEarnings } from "../../../supabase/functions/_shared/annualEarningsResolver.ts";

function makeAdminStub() {
  // Canonical monthly breakdown rows — mirrors payslip_lines shape.
  const monthly = [
    { month_index: 1, rule_code: "BASIC",       category: "earning",             employee_amount: 1000, employer_amount: 0,   taxable_amount: 900 },
    { month_index: 1, rule_code: "PAYE",        category: "statutory_employee",  employee_amount: 100,  employer_amount: 0,   taxable_amount: 0 },
    { month_index: 2, rule_code: "BASIC",       category: "earning",             employee_amount: 1000, employer_amount: 0,   taxable_amount: 900 },
    { month_index: 2, rule_code: "PENSION",     category: "deduction",           employee_amount: 50,   employer_amount: 50,  taxable_amount: 0 },
    { month_index: 2, rule_code: "NSSF_ER",     category: "statutory_employer",  employee_amount: 0,    employer_amount: 200, taxable_amount: 0 },
    { month_index: 2, rule_code: "GARNISHMENT", category: "post_tax_deduction",  employee_amount: 70,   employer_amount: 0,   taxable_amount: 0 },
  ];
  const rollup = [
    { rule_code: "BASIC",       category: "earning",            country_code: null, employee_amount: 2000, employer_amount: 0,   taxable_amount: 1800, payslip_count: 2, last_period_end: "2026-02-28" },
    { rule_code: "PAYE",        category: "statutory_employee", country_code: null, employee_amount: 100,  employer_amount: 0,   taxable_amount: 0,    payslip_count: 1, last_period_end: "2026-01-31" },
    { rule_code: "PENSION",     category: "deduction",          country_code: null, employee_amount: 50,   employer_amount: 50,  taxable_amount: 0,    payslip_count: 1, last_period_end: "2026-02-28" },
    { rule_code: "NSSF_ER",     category: "statutory_employer", country_code: null, employee_amount: 0,    employer_amount: 200, taxable_amount: 0,    payslip_count: 1, last_period_end: "2026-02-28" },
    { rule_code: "GARNISHMENT", category: "post_tax_deduction", country_code: null, employee_amount: 70,   employer_amount: 0,   taxable_amount: 0,    payslip_count: 1, last_period_end: "2026-02-28" },
  ];

  return {
    rpc: async (name: string) => {
      if (name === "payroll_employee_monthly_breakdown") return { data: monthly, error: null };
      if (name === "payroll_employee_ytd_rollup") return { data: rollup, error: null };
      return { data: [], error: null };
    },
    from: (_table: string) => {
      const chain: any = {
        _rows: [] as any[],
        select() { return chain; },
        eq() { return chain; },
        in() { return chain; },
        then(resolve: any) { resolve({ data: chain._rows, error: null }); return chain; },
      };
      return chain;
    },
  };
}

const commonParams = {
  organizationId: "org-1",
  businessId: "biz-1",
  employeeId: "emp-1",
  fiscalYear: 2026,
  branding: { name: "Acme", legal_name: null, address: null, phone: null, email: null },
  employee: {
    id: "emp-1",
    full_name: "Jane Doe",
    employee_number: "E-001",
    department: null,
    position: null,
    employment_status: "active",
    hire_date: "2024-01-01",
    termination_date: null,
  },
  currency: "USD",
  serialNumber: "AES-TEST-1",
  baseTemplateCode: "ANNUAL_EARNINGS_STATEMENT",
  issuer: null,
};

describe("resolveAnnualEarnings", () => {
  it("populates monthly rows from month_index (not row.month)", async () => {
    const dto = await resolveAnnualEarnings({ admin: makeAdminStub() as any, ...commonParams });
    expect(dto.months[0].month).toBe(1);
    expect(dto.months[0].month_index).toBe(1);
    expect(dto.months[0].gross).toBe(1000);
    expect(dto.months[0].statutory_employee).toBe(100);
    expect(dto.months[1].gross).toBe(1000);
    // other_deductions now sums both `deduction` (50) and `post_tax_deduction` (70).
    expect(dto.months[1].other_deductions).toBe(120);
    // Statutory (ER) monthly is fed from employer_amount.
    expect(dto.months[1].statutory_employer).toBe(200);
    expect(dto.months[5].gross).toBe(0);
  });

  it("routes post_tax_deduction into other_deductions and net", async () => {
    const dto = await resolveAnnualEarnings({ admin: makeAdminStub() as any, ...commonParams });
    // month 2: net = 1000 gross − 0 statutory_ee − 120 other_ded
    expect(dto.months[1].net).toBe(1000 - 120);
  });

  it("months and YTD reconcile by construction (single source of truth)", async () => {
    const dto = await resolveAnnualEarnings({ admin: makeAdminStub() as any, ...commonParams });
    const sum = (k: keyof typeof dto.months[number]) =>
      dto.months.reduce((s, m) => s + (m[k] as number), 0);
    expect(dto.ytd.gross).toBe(sum("gross"));
    expect(dto.ytd.taxable).toBe(sum("taxable"));
    expect(dto.ytd.statutory_employee).toBe(sum("statutory_employee"));
    expect(dto.ytd.statutory_employer).toBe(sum("statutory_employer"));
    expect(dto.ytd.other_deductions).toBe(sum("other_deductions"));
    expect(dto.ytd.reliefs).toBe(sum("reliefs"));
    expect(dto.ytd.net).toBe(sum("net"));
  });

  it("YTD figures match expected canonical totals", async () => {
    const dto = await resolveAnnualEarnings({ admin: makeAdminStub() as any, ...commonParams });
    expect(dto.ytd.gross).toBe(2000);
    expect(dto.ytd.statutory_employee).toBe(100);
    expect(dto.ytd.statutory_employer).toBe(200);
    expect(dto.ytd.other_deductions).toBe(120);
    expect(dto.ytd.taxable).toBe(1800);
    expect(dto.ytd.net).toBe(2000 - 100 - 120);
    // employer_contributions_total sums employer_amount across every row
    // (statutory_employer 200 + pension employer match 50 = 250).
    expect(dto.ytd.employer_contributions_total).toBe(250);
  });

  it("produces a deterministic content_hash across identical resolves", async () => {
    const a = await resolveAnnualEarnings({ admin: makeAdminStub() as any, ...commonParams });
    const b = await resolveAnnualEarnings({ admin: makeAdminStub() as any, ...commonParams });
    expect(a.provenance.content_hash).toHaveLength(64);
    expect(a.provenance.content_hash).toBe(b.provenance.content_hash);
  });
});

/**
 * annualEarningsResolver — regression guard.
 *
 * Root causes this test locks down (ADR-0091 hardening):
 *
 *   1. RPC column name: `payroll_employee_monthly_breakdown` returns
 *      `month_index`, not `month`. Reading the wrong column silently
 *      zeroed every month and every YTD total.
 *   2. Single-source YTD: `ytd` must be derived from the canonical
 *      `payroll_employee_ytd_rollup` rows, not by summing months.
 *      Otherwise the two aggregations drift (already happened with the
 *      non-existent `taxable` category).
 *   3. Determinism: two resolves with identical inputs must produce an
 *      identical `provenance.content_hash`.
 */
import { describe, it, expect } from "vitest";
import { resolveAnnualEarnings } from "../../../supabase/functions/_shared/annualEarningsResolver.ts";

function makeAdminStub() {
  // Canonical monthly breakdown rows — note the RPC column is
  // `month_index` (not `month`). Any regression to `row.month` will
  // zero these out and fail the assertions below.
  const monthly = [
    { month_index: 1, rule_code: "BASIC",   category: "earning",             employee_amount: 1000, employer_amount: 0,   taxable_amount: 900 },
    { month_index: 1, rule_code: "PAYE",    category: "statutory_employee",  employee_amount: 100,  employer_amount: 0,   taxable_amount: 0 },
    { month_index: 2, rule_code: "BASIC",   category: "earning",             employee_amount: 1000, employer_amount: 0,   taxable_amount: 900 },
    { month_index: 2, rule_code: "PENSION", category: "deduction",           employee_amount: 50,   employer_amount: 50,  taxable_amount: 0 },
  ];
  const rollup = [
    { rule_code: "BASIC",   category: "earning",            country_code: null, employee_amount: 2000, employer_amount: 0,  taxable_amount: 1800, payslip_count: 2, last_period_end: "2026-02-28" },
    { rule_code: "PAYE",    category: "statutory_employee", country_code: null, employee_amount: 100,  employer_amount: 0,  taxable_amount: 0,    payslip_count: 1, last_period_end: "2026-01-31" },
    { rule_code: "PENSION", category: "deduction",          country_code: null, employee_amount: 50,   employer_amount: 50, taxable_amount: 0,    payslip_count: 1, last_period_end: "2026-02-28" },
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
    expect(dto.months[0].gross).toBe(1000);
    expect(dto.months[0].statutory_employee).toBe(100);
    expect(dto.months[1].gross).toBe(1000);
    expect(dto.months[1].other_deductions).toBe(50);
    // Non-populated months stay zero.
    expect(dto.months[5].gross).toBe(0);
  });

  it("derives YTD from the canonical rollup, not by summing months", async () => {
    const dto = await resolveAnnualEarnings({ admin: makeAdminStub() as any, ...commonParams });
    expect(dto.ytd.gross).toBe(2000);
    expect(dto.ytd.statutory_employee).toBe(100);
    expect(dto.ytd.other_deductions).toBe(50);
    // taxable comes from `taxable_amount` on the rollup rows, NOT from a
    // non-existent `category: 'taxable'`.
    expect(dto.ytd.taxable).toBe(1800);
    // net = gross + benefits − statutory_ee − other_deductions
    expect(dto.ytd.net).toBe(2000 - 100 - 50);
  });

  it("months and YTD agree by construction (single source of truth)", async () => {
    const dto = await resolveAnnualEarnings({ admin: makeAdminStub() as any, ...commonParams });
    const summed = dto.months.reduce((s, m) => s + m.gross, 0);
    expect(summed).toBe(dto.ytd.gross);
  });

  it("produces a deterministic content_hash across identical resolves", async () => {
    const a = await resolveAnnualEarnings({ admin: makeAdminStub() as any, ...commonParams });
    const b = await resolveAnnualEarnings({ admin: makeAdminStub() as any, ...commonParams });
    expect(a.provenance.content_hash).toHaveLength(64);
    expect(a.provenance.content_hash).toBe(b.provenance.content_hash);
  });
});
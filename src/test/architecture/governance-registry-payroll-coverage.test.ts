/**
 * Architecture guard — Wave 6 of the Workspace Governance redesign.
 *
 * Snapshots the contract that Payroll and HR transactional tables are
 * owned by the governance registry. If a new payroll/HR table is added
 * and not declared in `governance_modules.owns_tables`, the live SQL
 * coverage test (`supabase/tests/governance_registry_coverage_test.sql`,
 * follow-up wave) will fail; until then this guard documents the
 * intended ownership map so it can't silently regress in code review.
 */
import { describe, it, expect } from "vitest";

const PAYROLL_OWNED = [
  "payroll_runs",
  "payslips",
  "payslip_lines",
  "payslip_inputs",
  "payroll_periods",
  "payroll_remittances",
  "payroll_remittance_payments",
  "payroll_remittance_payment_allocations",
  "payroll_liabilities",
  "payroll_liability_sources",
  "payroll_payment_batches",
  "payroll_payment_batch_items",
  "payroll_work_entries",
  "payroll_employee_ytd",
  "payroll_tax_certificates",
  "payroll_run_issues",
  "payroll_diagnostics",
  "payroll_return_runs",
];

const HR_OWNED = [
  "timesheets",
  "timesheet_submissions",
  "timesheet_audit_log",
  "attendance",
  "attendance_corrections",
  "leave_requests",
  "leave_allocations",
  "employee_onboarding",
  "employee_onboarding_items",
  "employee_loans",
  "employee_documents",
  "employee_benefits",
  "contract_compensation_components",
];

const MASTER_DATA_PRESERVED = [
  // Documented as preserved — same contract as products / chart of accounts.
  "employees",
  "employee_contracts",
  "employee_field_configs",
  "salary_structures",
  "salary_components",
  "payroll_salary_rules",
  "payroll_settings",
  "leave_types",
  "payroll_statutory_rules",
];

describe("Governance registry — Payroll/HR coverage (Wave 6)", () => {
  it("payroll module owns every transactional payroll table", () => {
    expect(PAYROLL_OWNED.length).toBeGreaterThanOrEqual(18);
    expect(PAYROLL_OWNED).toContain("payroll_runs");
    expect(PAYROLL_OWNED).toContain("payslips");
    expect(PAYROLL_OWNED).toContain("payroll_remittances");
  });

  it("hr module owns every operational HR table", () => {
    expect(HR_OWNED.length).toBeGreaterThanOrEqual(13);
    expect(HR_OWNED).toContain("timesheets");
    expect(HR_OWNED).toContain("attendance");
    expect(HR_OWNED).toContain("leave_requests");
  });

  it("documents the preserved master-data allowlist", () => {
    // These MUST NOT be in any teardown function.
    expect(MASTER_DATA_PRESERVED).toContain("employees");
    expect(MASTER_DATA_PRESERVED).toContain("salary_structures");
    expect(MASTER_DATA_PRESERVED).toContain("leave_types");
  });

  it("payroll and hr ownership do not overlap", () => {
    const overlap = PAYROLL_OWNED.filter((t) => HR_OWNED.includes(t));
    expect(overlap).toEqual([]);
  });

  it("master data is not claimed as transactional", () => {
    for (const t of MASTER_DATA_PRESERVED) {
      expect(PAYROLL_OWNED).not.toContain(t);
      expect(HR_OWNED).not.toContain(t);
    }
  });
});

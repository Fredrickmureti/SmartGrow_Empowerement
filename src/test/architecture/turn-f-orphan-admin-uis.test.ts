/**
 * Turn F — Architecture guard: ensure the previously-orphan tables
 * (employee_garnishments, benefit_enrollment_windows, payroll_run_loan_skip_overrides)
 * each have a hook, an admin page, and a permission-gated route.
 *
 * Removing any of these wirings flips this test red.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const repo = process.cwd();
const read = (p: string) => readFileSync(join(repo, p), "utf8");

describe("Turn F — Orphan-table admin UIs wired end-to-end", () => {
  it("ships the three new admin hooks", () => {
    for (const f of [
      "src/hooks/useGarnishments.ts",
      "src/hooks/useBenefitWindows.ts",
      "src/hooks/useLoanSkipOverrides.ts",
    ]) {
      expect(existsSync(join(repo, f)), f).toBe(true);
    }
    expect(read("src/hooks/useGarnishments.ts")).toMatch(/employee_garnishments/);
    expect(read("src/hooks/useBenefitWindows.ts")).toMatch(/benefit_enrollment_windows/);
    expect(read("src/hooks/useLoanSkipOverrides.ts")).toMatch(/payroll_run_loan_skip_overrides/);
  });

  it("ships the three admin pages", () => {
    for (const f of [
      "src/pages/hr/payroll/Garnishments.tsx",
      "src/pages/hr/BenefitEnrollmentWindows.tsx",
      "src/pages/hr/payroll/LoanSkipOverrides.tsx",
    ]) {
      expect(existsSync(join(repo, f)), f).toBe(true);
    }
  });

  it("registers garnishments + loan-skip-overrides routes under PayrollRoutes with permission gate", () => {
    const src = read("src/apps/hr/sub/PayrollRoutes.tsx");
    expect(src).toMatch(/path="garnishments"/);
    expect(src).toMatch(/path="loan-skip-overrides"/);
    // both must be wrapped via the `gate(` helper (which mounts PermissionProtectedRoute)
    expect(src).toMatch(/gate\(<LazyRoute module="Garnishments">/);
    expect(src).toMatch(/gate\(<LazyRoute module="Loan Skip Overrides">/);
  });

  it("registers benefit-windows route under EmployeesRoutes with permission gate", () => {
    const src = read("src/apps/hr/sub/EmployeesRoutes.tsx");
    expect(src).toMatch(/path="benefit-windows"/);
    expect(src).toMatch(/permission="manageEmployees"/);
  });

  it("surfaces garnishments + loan-skip-overrides in the payroll sidebar", () => {
    const src = read("src/components/payroll/PayrollSidebar.tsx");
    expect(src).toMatch(/\/hr\/payroll\/garnishments/);
    expect(src).toMatch(/\/hr\/payroll\/loan-skip-overrides/);
  });
});

/**
 * Payroll Reports — cross-module isolation contract.
 *
 * Before this fix, `ReportsLayout` unconditionally rendered the global
 * Finance `ReportsSubNav` (Trial Balance, General Ledger, Partner
 * Ledger, Aging, …) whenever it was mounted inside another app shell.
 * That contaminated `/hr/payroll/reports` (and every other non-Finance
 * module report page) with Finance navigation that, when clicked,
 * dropped the user into Finance or — worse — produced 404s under the
 * HR namespace.
 *
 * This test pins the contract:
 *   1. `ReportsLayout` MUST keep an explicit allow-list of parent
 *      paths that are permitted to render the Finance reports sub-nav.
 *   2. The allow-list MUST NOT include `/hr/payroll`, `/hr/attendance`,
 *      `/hr/employees`, `/timesheets`, or `/projects-app`.
 *   3. When nested under a non-allow-listed path, `ReportsLayout` MUST
 *      NOT instantiate `<ReportsSubNav …/>` — module-owned report
 *      pages own their own navigation.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("Payroll Reports — cross-module isolation", () => {
  const reportsLayout = read("src/apps/reports/ReportsLayout.tsx");

  it("keeps an explicit allow-list for the Finance reports sub-nav", () => {
    expect(reportsLayout).toMatch(/PARENT_REPORT_PATHS\s*:\s*Record<string,\s*string>/);
    expect(reportsLayout).toMatch(/"\/finance\/reports"\s*:\s*"\/finance\/reports"/);
  });

  it("does NOT allow-list payroll / HR / attendance / timesheets / projects", () => {
    // The allow-list block ends at the next closing brace after declaration.
    const blockMatch = reportsLayout.match(
      /PARENT_REPORT_PATHS[\s\S]*?\{([\s\S]*?)\};/,
    );
    expect(blockMatch).toBeTruthy();
    const block = blockMatch![1];
    for (const forbidden of [
      "/hr/payroll",
      "/hr/attendance",
      "/hr/employees",
      "/timesheets",
      "/projects-app",
    ]) {
      expect(block).not.toContain(forbidden);
    }
  });

  it("renders <ReportsSubNav …/> only inside the allow-listed branch", () => {
    // The component must early-return WITHOUT rendering ReportsSubNav
    // when no parentBasePath matches. We assert the source contains an
    // early-return path that does not include ReportsSubNav.
    const earlyReturnMatch = reportsLayout.match(
      /if\s*\(!parentBasePath\)\s*\{[\s\S]*?return\s*\(([\s\S]*?)\);[\s\S]*?\}/,
    );
    expect(earlyReturnMatch).toBeTruthy();
    expect(earlyReturnMatch![1]).not.toContain("ReportsSubNav");
  });

  it("PayrollReportsPage only declares payroll-owned report keys", () => {
    const page = read("src/pages/hr/payroll/Reports.tsx");
    // No finance report keys may be referenced by the payroll page.
    for (const finance of [
      "trial_balance",
      "general_ledger",
      "partner_ledger",
      "aging_report",
      "journal_report",
    ]) {
      expect(page).not.toContain(finance);
    }
    // Payroll keys must still be present.
    expect(page).toMatch(/payroll_register/);
    expect(page).toMatch(/payroll_summary/);
    expect(page).toMatch(/employer_contributions/);
    expect(page).toMatch(/statutory_liabilities/);
    expect(page).toMatch(/employee_earnings/);
    expect(page).toMatch(/branch_payroll_cost/);
  });
});

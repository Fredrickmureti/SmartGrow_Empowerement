/**
 * Turn G + H + I + J + K — Architecture guards for the final five turns.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const repo = process.cwd();
const read = (p: string) => readFileSync(join(repo, p), "utf8");
const exists = (p: string) => existsSync(join(repo, p));

describe("Turn G–K — final HR/payroll completion", () => {
  it("Turn G: HRAnalyticsPanel exists and is wired into HRDashboard + HRReports", () => {
    expect(exists("src/hooks/useHRAnalytics.ts")).toBe(true);
    expect(exists("src/components/hr/HRAnalyticsPanel.tsx")).toBe(true);
    expect(read("src/pages/hr/HRDashboard.tsx")).toMatch(/HRAnalyticsPanel/);
    expect(read("src/pages/hr/HRReports.tsx")).toMatch(/HRAnalyticsPanel/);
    const hook = read("src/hooks/useHRAnalytics.ts");
    for (const v of ["v_hr_headcount_snapshot","v_hr_turnover_rolling_12m","v_payroll_cost_by_department","v_leave_liability_open"]) {
      expect(hook).toMatch(new RegExp(v));
    }
  });

  it("Turn H: recruitment hook + page + careers + route registration", () => {
    expect(exists("src/hooks/useRecruitment.ts")).toBe(true);
    expect(exists("src/pages/hr/Recruitment.tsx")).toBe(true);
    expect(exists("src/pages/Careers.tsx")).toBe(true);
    expect(exists("src/apps/hr/sub/RecruitmentRoutes.tsx")).toBe(true);
    expect(read("src/apps/hr/routes.tsx")).toMatch(/RecruitmentApp/);
    expect(read("src/App.tsx")).toMatch(/\/careers/);
    expect(read("src/hooks/useRecruitment.ts")).toMatch(/convert_application_to_employee/);
  });

  it("Turn I: performance + training hooks present; /hr/performance redirects into Talent", () => {
    expect(exists("src/hooks/usePerformance.ts")).toBe(true);
    // PerformanceTraining.tsx was retired during the IA convergence — the
    // /hr/performance URL is preserved via a dispatcher redirect to
    // /hr/talent/dashboard so legacy links continue to resolve.
    expect(read("src/apps/hr/sub/EmployeesRoutes.tsx")).toMatch(/path="performance"/);
    const hook = read("src/hooks/usePerformance.ts");
    for (const t of ["performance_cycles","performance_goals","training_courses","training_enrollments","competencies","employee_competencies"]) {
      expect(hook).toMatch(new RegExp(t));
    }
  });


  it("Turn J: idempotency wired into createLeaveRequest, PAYROLL_NO_LOCALIZATION_PACK hint mapped", () => {
    const leave = read("src/hooks/leave/useLeaveRequests.ts");
    expect(leave).toMatch(/idempotency_key/);
    expect(leave).toMatch(/idempotencyKey/);
    expect(read("src/lib/edgeFunctionError.ts")).toMatch(/PAYROLL_NO_LOCALIZATION_PACK/);
  });

  it("Turn K: probation + final settlement cards exist and are wired", () => {
    expect(exists("src/components/hr/ProbationEndingCard.tsx")).toBe(true);
    expect(exists("src/components/hr/FinalSettlementReconciliationCard.tsx")).toBe(true);
    expect(read("src/pages/hr/HRDashboard.tsx")).toMatch(/ProbationEndingCard/);
    expect(read("src/pages/hr/HRReports.tsx")).toMatch(/FinalSettlementReconciliationCard/);
  });
});

/**
 * HR Reports Sub-App Routes (Wave 1 — new).
 *
 * Replaces the legacy KPI dashboard with a question-driven library:
 * each report is a (title, params, loader, default viz) tuple.
 * Wave-1 data sources land as views (v_hr_headcount_by_department,
 * v_hr_workforce_growth_monthly, v_hr_turnover_monthly, …).
 */

import { lazy } from "react";
import { Routes, Route } from "react-router-dom";
import { EMPLOYEES_APP } from "@/lib/apps/registry";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { EMPLOYEES_NAV } from "../shared/navs";
import { LazyRoute } from "../shared/guards";

const WorkspaceComingSoon = lazy(() => import("@/pages/hr/WorkspaceComingSoon"));

function ReportStub({ surface, description }: { surface: string; description: string }) {
  return (
    <LazyRoute module={`HR Reports — ${surface}`}>
      <WorkspaceComingSoon title={`Reports · ${surface}`} description={description} />
    </LazyRoute>
  );
}

export default function HrReportsApp() {
  return (
    <PlatformShell app={EMPLOYEES_APP} nav={EMPLOYEES_NAV}>
      <Routes>
        <Route index element={<ReportStub surface="All questions" description="Library grid grouped by domain." />} />
        <Route path="workforce" element={<ReportStub surface="Workforce" description="Growth, headcount, turnover, attendance compliance." />} />
        <Route path="contracts" element={<ReportStub surface="Contracts" description="Expiry pipeline, renewals throughput, amendment frequency." />} />
        <Route path="leave" element={<ReportStub surface="Leave" description="Liability, usage, approval SLA." />} />
        <Route path="payroll" element={<ReportStub surface="Payroll" description="Distribution by department, statutory cost, retro adjustments." />} />
        <Route path="talent" element={<ReportStub surface="Talent" description="Promotion pipeline, succession readiness, 9-box." />} />
        <Route path="org" element={<ReportStub surface="Organization" description="Change history, department drilldowns, position fill rate." />} />
        <Route path="saved" element={<ReportStub surface="Saved views" description="Per-user saved filter sets across the library." />} />
        <Route path="scheduled" element={<ReportStub surface="Scheduled" description="Reuses scheduled_reports for question-based exports." />} />
      </Routes>
    </PlatformShell>
  );
}
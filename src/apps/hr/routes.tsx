/**
 * HR-Domain Dispatcher (back-compat URL space `/hr/*`)
 *
 * The HR domain has been split into FIVE Odoo-aligned, independently
 * installable apps:
 *
 *   - Employees   (foundation — directory, departments, contracts, reports)
 *   - Time Off    (hr_holidays — leave types, allocations, approvals)
 *   - Attendances (hr_attendance — clock-in oversight, work schedules)
 *   - Payroll     (hr_payroll — runs, payslips, loans, statutory, remittances)
 *   - Recruitment (hr_recruitment — coming soon)
 *
 * To preserve existing URLs (deep links, bookmarks, edge function callbacks),
 * all five apps still mount under `/hr/*`. This file is a thin dispatcher
 * that routes each top-level URL fragment to the matching sub-app shell.
 *
 * Each sub-app brings its own AppWorkspaceLayout + AppDefinition, so the
 * topbar always shows the correct module list — no URL sniffing inside the
 * layout. The legacy `resolveHrApp` switch is gone.
 *
 * Self-service surfaces (`/hr/my-portal`, `/hr/my-profile`, `/hr/timesheets`,
 * `/hr/documents`) redirect to `/me/*` (My Workspace shell).
 */

import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { RouteLoadingFallback } from "@/components/common/RouteLoadingFallback";
import { HRCatchAllRedirect } from "./shared/guards";
import { AppInstalledGate } from "@/components/apps/AppInstalledGate";
import { HR_REDIRECTS } from "./shared/redirects";

// Each sub-app is independently lazy-loaded so installing only Employees
// does not download Payroll/Time Off bundles for that user's session.
const EmployeesApp = lazy(() => import("./sub/EmployeesRoutes"));
const TimeOffApp = lazy(() => import("./sub/TimeOffRoutes"));
const AttendanceApp = lazy(() => import("./sub/AttendanceRoutes"));
const PayrollApp = lazy(() => import("./sub/PayrollRoutes"));
const RecruitmentApp = lazy(() => import("./sub/RecruitmentRoutes"));
const TalentApp = lazy(() => import("./sub/TalentRoutes"));
// Wave-1 sub-apps (Contracts, Lifecycle, HR Reports). The standalone Org
// workspace has been folded into Employees — its routes redirect via
// HR_REDIRECTS to /hr/employees/*.
const ContractsApp = lazy(() => import("./sub/ContractsRoutes"));
const LifecycleApp = lazy(() => import("./sub/LifecycleRoutes"));
const HrReportsApp = lazy(() => import("./sub/HrReportsRoutes"));
const DocumentComplianceApp = lazy(() => import("./sub/DocumentComplianceRoutes"));

function SubAppFallback({ module }: { module: string }) {
  return <RouteLoadingFallback module={module} />;
}

export function HRApp() {
  return (
    <Suspense fallback={<SubAppFallback module="HR" />}>
      <Routes>
        {/* Recruitment (Turn H — re-activated) */}
        <Route path="recruitment/*" element={<RecruitmentApp />} />

        {/* Departments, Job positions, Work locations and the Org chart
            are part of the Employees app (Odoo `hr` pattern). Legacy
            /hr/org/* URLs redirect into Employees via HR_REDIRECTS below. */}
        <Route
          path="contracts/*"
          element={
            <AppInstalledGate appId="employees">
              <ContractsApp />
            </AppInstalledGate>
          }
        />
        <Route
          path="lifecycle/*"
          element={
            <AppInstalledGate appId="employees">
              <LifecycleApp />
            </AppInstalledGate>
          }
        />
        <Route
          path="reports/*"
          element={
            <AppInstalledGate appId="employees">
              <HrReportsApp />
            </AppInstalledGate>
          }
        />
        <Route
          path="document-compliance/*"
          element={
            <AppInstalledGate appId="employees">
              <DocumentComplianceApp />
            </AppInstalledGate>
          }
        />


        {/*
         * Wave-1 redirects: legacy /hr/* URLs → their new workspace owners.
         * The dispatcher is mounted at `/hr/*`, so each HR_REDIRECTS key
         * (an absolute `/hr/...` path) is converted to a dispatcher-relative
         * slug; we emit both the bare slug and a `/*` splat so that exact
         * URLs and any trailing segments resolve. `shared/redirects.ts` is
         * the single source of truth — do NOT add inline <Navigate /> here.
         */}
        {Object.entries(HR_REDIRECTS)
          .filter(([from]) => from.startsWith("/hr/"))
          .flatMap(([from, to]) => {
            const slug = from.slice("/hr/".length);
            return [
              <Route key={from} path={slug} element={<Navigate to={to} replace />} />,
              <Route key={`${from}/*`} path={`${slug}/*`} element={<Navigate to={to} replace />} />,
            ];
          })}


        {/* Talent (performance, goals, reviews, competencies, learning, development) */}
        <Route
          path="talent/*"
          element={
            <AppInstalledGate appId="talent">
              <TalentApp />
            </AppInstalledGate>
          }
        />


        {/* Time Off subtree */}
        <Route
          path="leave/*"
          element={
            <AppInstalledGate appId="time-off">
              <TimeOffApp />
            </AppInstalledGate>
          }
        />

        {/* Attendance subtrees */}
        <Route
          path="attendance/*"
          element={
            <AppInstalledGate appId="attendance">
              <AttendanceApp surface="attendance" />
            </AppInstalledGate>
          }
        />
        <Route
          path="work-schedules/*"
          element={
            <AppInstalledGate appId="attendance">
              <AttendanceApp surface="work-schedules" />
            </AppInstalledGate>
          }
        />

        {/* Payroll subtrees */}
        <Route
          path="payroll/*"
          element={
            <AppInstalledGate appId="payroll">
              <PayrollApp surface="payroll" />
            </AppInstalledGate>
          }
        />
        <Route
          path="remittances/*"
          element={
            <AppInstalledGate appId="payroll">
              <PayrollApp surface="remittances" />
            </AppInstalledGate>
          }
        />

        {/* Self-service legacy redirects (/hr/my-profile, /hr/my-portal,
            /hr/timesheets, /hr/documents → /me/*) are emitted from
            HR_REDIRECTS above. */}

        {/* Employees foundation — catch-all */}
        <Route
          path="*"
          element={
            <AppInstalledGate appId="employees">
              <EmployeesApp />
            </AppInstalledGate>
          }
        />

        <Route path="hr-fallback" element={<HRCatchAllRedirect />} />
      </Routes>
    </Suspense>
  );
}

export default HRApp;

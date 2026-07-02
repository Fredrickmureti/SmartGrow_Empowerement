/**
 * Timesheets App Routes — admin / manager surface only.
 *
 *   /timesheets                → Pending approvals queue (manager landing)
 *   /timesheets/team           → Team weekly view (managers / HR / admin)
 *   /timesheets/approvals      → Alias of index
 *   /timesheets/by-project     → Hours rolled up by project
 *   /timesheets/reports        → Built-in reports
 *   /timesheets/settings       → Org timesheet settings
 *
 * Employee self-service entry lives at /me/timesheets (see MeApp). The legacy
 * /timesheets/my path redirects there so existing deep links keep working.
 */
import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { AppInstalledGate } from "@/components/apps/AppInstalledGate";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { RouteLoadingFallback } from "@/components/common/RouteLoadingFallback";
import { TIMESHEETS_APP } from "@/lib/apps/registry";
import { TIMESHEETS_NAV } from "./nav";

const TimesheetApprovals = lazy(() => import("@/pages/timesheets/TimesheetApprovals"));
const TeamTimesheets = lazy(() => import("@/pages/timesheets/TeamTimesheets"));
const TimesheetByProject = lazy(() => import("@/pages/timesheets/ByProject"));
const TimesheetReports = lazy(() => import("@/pages/timesheets/TimesheetReports"));
const TimesheetSettings = lazy(() => import("@/pages/timesheets/TimesheetSettings"));

export default function TimesheetsRoutes() {
  return (
    <AppInstalledGate appId="timesheets">
      <PlatformShell app={TIMESHEETS_APP} nav={TIMESHEETS_NAV} fullWidth>
        <Suspense fallback={<RouteLoadingFallback module="Timesheets" />}>
          <div className="mx-auto w-full max-w-screen-2xl">
            <Routes>
              <Route index element={<TimesheetApprovals />} />
              <Route path="my" element={<Navigate to="/me/timesheets" replace />} />
              <Route path="team" element={<TeamTimesheets />} />
              <Route path="approvals" element={<TimesheetApprovals />} />
              <Route path="by-project" element={<TimesheetByProject />} />
              <Route path="reports" element={<TimesheetReports />} />
              <Route path="settings" element={<TimesheetSettings />} />
            </Routes>
          </div>
        </Suspense>
      </PlatformShell>
    </AppInstalledGate>
  );
}


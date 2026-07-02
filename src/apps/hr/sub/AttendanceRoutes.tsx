/**
 * Attendance Sub-App Routes (Odoo `hr_attendance`)
 *
 * Surfaces:
 *   /hr/attendance              → Attendance overview (admin)
 *   /hr/attendance/corrections  → Correction queue (manager)
 *   /hr/attendance/reports      → Analytical buckets (manager)
 *   /hr/attendance/settings     → Runtime-used settings (HR admin)
 *   /hr/attendance/kiosk        → Chrome-less PIN kiosk
 *   /hr/work-schedules          → Work schedule definitions
 *
 * Personal attendance entry lives under /me/attendance.
 */

import { lazy, type ReactNode } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { PermissionProtectedRoute } from "@/components/auth/PermissionProtectedRoute";
import { ATTENDANCE_APP } from "@/lib/apps/registry";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { ATTENDANCE_NAV } from "../shared/navs";
import { LazyRoute, PortalOrSubscriptionGate } from "../shared/guards";

const Attendance = lazy(() => import("@/pages/hr/Attendance"));
const AttendanceApprovals = lazy(() => import("@/pages/hr/AttendanceApprovals"));
const AttendanceReports = lazy(() => import("@/pages/hr/AttendanceReports"));
const AttendanceSettingsPage = lazy(() => import("@/pages/hr/AttendanceSettingsPage"));
const AttendanceAudit = lazy(() => import("@/pages/hr/AttendanceAudit"));
const AttendanceDevices = lazy(() => import("@/pages/hr/AttendanceDevices"));
const WorkSchedules = lazy(() => import("@/pages/hr/WorkSchedules"));
const Shifts = lazy(() => import("@/pages/hr/Shifts"));
const Roster = lazy(() => import("@/pages/hr/Roster"));
// B1: AttendanceMyTeam page is collapsed into Today (?scope=team). Import kept
// removed; the team scope is rendered by Attendance.tsx via the existing chip.

/** Preserve ?row=<id> when redirecting legacy URLs into the hub. */
function RedirectToApprovals({ tab }: { tab: "corrections" | "overtime" }) {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  params.set("tab", tab);
  return <Navigate to={`/hr/attendance/approvals?${params.toString()}`} replace />;
}

/** B1: /hr/attendance/team is collapsed into Today via ?scope=team.
 *  Preserves any pre-existing query params from email/deep links. */
function RedirectTeamToToday() {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  params.set("scope", "team");
  return <Navigate to={`/hr/attendance?${params.toString()}`} replace />;
}

interface AttendanceAppProps {
  surface: "attendance" | "work-schedules";
}

export function AttendanceApp({ surface }: AttendanceAppProps) {
  if (surface === "work-schedules") {
    return (
      <PlatformShell app={ATTENDANCE_APP} nav={ATTENDANCE_NAV}>
        <Routes>
          <Route
            path="*"
            element={
              <PermissionProtectedRoute permission="manageWorkSchedule" fallbackPath="/hr/attendance">
                <LazyRoute module="Work Schedules">
                  <WorkSchedules />
                </LazyRoute>
              </PermissionProtectedRoute>
            }
          />
        </Routes>
      </PlatformShell>
    );
  }

  return (
    <PlatformShell app={ATTENDANCE_APP} nav={ATTENDANCE_NAV}>
      {/*
       * Flattened Routes (Phase A). The legacy structure wrapped every
       * surface in a parent `<Route path="*" element={<Gate><Routes>...</>}>`
       * — that double-nested router caused a shell remount on every click
       * (Gate unmounts when the inner Routes pick a different leaf). Each
       * leaf now declares its own permission gate; the workspace-wide
       * viewAttendance + subscription gate sits inside `WithGate` so the
       * `<PlatformShell>` chrome stays mounted across navigation.
       */}
      <Routes>
        <Route index element={<WithGate><LazyRoute module="Attendance"><Attendance /></LazyRoute></WithGate>} />
        <Route
          path="approvals"
          element={
            <WithGate manage>
              <LazyRoute module="Approvals"><AttendanceApprovals /></LazyRoute>
            </WithGate>
          }
        />
        <Route path="team" element={<RedirectTeamToToday />} />
        <Route path="corrections" element={<RedirectToApprovals tab="corrections" />} />
        <Route path="overtime" element={<RedirectToApprovals tab="overtime" />} />
        <Route
          path="reports"
          element={<WithGate><LazyRoute module="Attendance Reports"><AttendanceReports /></LazyRoute></WithGate>}
        />
        <Route
          path="settings"
          element={<WithGate manage><LazyRoute module="Attendance Settings"><AttendanceSettingsPage /></LazyRoute></WithGate>}
        />
        <Route
          path="audit"
          element={<WithGate manage><LazyRoute module="Attendance Audit"><AttendanceAudit /></LazyRoute></WithGate>}
        />
        <Route
          path="shifts"
          element={<WithGate manage><LazyRoute module="Shifts"><Shifts /></LazyRoute></WithGate>}
        />
        <Route
          path="roster"
          element={<WithGate manage><LazyRoute module="Roster"><Roster /></LazyRoute></WithGate>}
        />
        <Route
          path="devices"
          element={<WithGate manage><LazyRoute module="Attendance Devices"><AttendanceDevices /></LazyRoute></WithGate>}
        />
      </Routes>
    </PlatformShell>
  );
}

export default AttendanceApp;

/**
 * Combines the workspace-wide subscription + viewAttendance gate with an
 * optional inner `manageAttendance` check. Replaces the previous double
 * `<Routes>` nesting by gating each leaf in place.
 */
function WithGate({ children, manage = false }: { children: ReactNode; manage?: boolean }) {
  const inner = (
    <PortalOrSubscriptionGate>
      <PermissionProtectedRoute permission="viewAttendance" fallbackPath="/me">
        {manage ? (
          <PermissionProtectedRoute permission="manageAttendance" fallbackPath="/hr/attendance">
            {children}
          </PermissionProtectedRoute>
        ) : (
          children
        )}
      </PermissionProtectedRoute>
    </PortalOrSubscriptionGate>
  );
  return inner;
}

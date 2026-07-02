/**
 * Time Off Sub-App Routes (Odoo `hr_holidays`)
 *
 * Admin surfaces for leave types, allocations, public holidays, and approvals.
 * Self-service leave requests live under /me/leave.
 *
 * Mounted at /hr/leave/* by the HR dispatcher.
 */

import { lazy } from "react";
import { Routes, Route, Navigate, useSearchParams } from "react-router-dom";
import { PermissionProtectedRoute } from "@/components/auth/PermissionProtectedRoute";
import { TIME_OFF_APP } from "@/lib/apps/registry";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { TIME_OFF_NAV } from "../shared/navs";
import { LazyRoute, PortalOrSubscriptionGate } from "../shared/guards";

const LeaveDashboard = lazy(() => import("@/pages/leave/LeaveDashboard"));
const LeaveAllocations = lazy(() => import("@/pages/leave/LeaveAllocations"));
const LeaveApprovals = lazy(() => import("@/pages/leave/LeaveApprovals"));
const LeaveCalendar = lazy(() => import("@/pages/leave/LeaveCalendar"));
const LeaveHolidays = lazy(() => import("@/pages/leave/LeaveHolidays"));
const LeaveTypes = lazy(() => import("@/pages/leave/LeaveTypes"));

/**
 * Back-compat redirect for legacy `?tab=` deep links from the old single-page
 * dashboard. Keeps bookmarks / notification links working after the route split.
 */
function LegacyTabRedirect() {
  const [params] = useSearchParams();
  const tab = params.get("tab");
  if (tab === "approvals") return <Navigate to="/hr/leave/approvals" replace />;
  if (tab === "team-calendar") return <Navigate to="/hr/leave/calendar" replace />;
  if (tab === "holidays") return <Navigate to="/hr/leave/holidays" replace />;
  if (tab === "types") return <Navigate to="/hr/leave/types" replace />;
  return null;
}

export function TimeOffApp() {
  return (
    <PlatformShell app={TIME_OFF_APP} nav={TIME_OFF_NAV}>
      <LegacyTabRedirect />
      <Routes>
        <Route
          index
          element={
            <PermissionProtectedRoute permission="viewLeave" fallbackPath="/me/leave">
              <PortalOrSubscriptionGate>
                <LazyRoute module="Leave Management">
                  <LeaveDashboard />
                </LazyRoute>
              </PortalOrSubscriptionGate>
            </PermissionProtectedRoute>
          }
        />

        <Route
          path="approvals"
          element={
            <PermissionProtectedRoute permission="viewLeave" fallbackPath="/hr/leave">
              <PortalOrSubscriptionGate>
                <LazyRoute module="Leave Approvals">
                  <LeaveApprovals />
                </LazyRoute>
              </PortalOrSubscriptionGate>
            </PermissionProtectedRoute>
          }
        />

        <Route
          path="calendar"
          element={
            <PermissionProtectedRoute permission="viewLeave" fallbackPath="/hr/leave">
              <PortalOrSubscriptionGate>
                <LazyRoute module="Team Leave Calendar">
                  <LeaveCalendar />
                </LazyRoute>
              </PortalOrSubscriptionGate>
            </PermissionProtectedRoute>
          }
        />

        <Route
          path="allocations"
          element={
            <PermissionProtectedRoute permission="manageLeaveTypes" fallbackPath="/hr/leave">
              <PortalOrSubscriptionGate>
                <LazyRoute module="Leave Allocations">
                  <LeaveAllocations />
                </LazyRoute>
              </PortalOrSubscriptionGate>
            </PermissionProtectedRoute>
          }
        />

        <Route
          path="holidays"
          element={
            <PermissionProtectedRoute permission="manageLeaveTypes" fallbackPath="/hr/leave">
              <PortalOrSubscriptionGate>
                <LazyRoute module="Public Holidays">
                  <LeaveHolidays />
                </LazyRoute>
              </PortalOrSubscriptionGate>
            </PermissionProtectedRoute>
          }
        />

        <Route
          path="types"
          element={
            <PermissionProtectedRoute permission="manageLeaveTypes" fallbackPath="/hr/leave">
              <PortalOrSubscriptionGate>
                <LazyRoute module="Leave Types">
                  <LeaveTypes />
                </LazyRoute>
              </PortalOrSubscriptionGate>
            </PermissionProtectedRoute>
          }
        />
      </Routes>
    </PlatformShell>
  );
}

export default TimeOffApp;

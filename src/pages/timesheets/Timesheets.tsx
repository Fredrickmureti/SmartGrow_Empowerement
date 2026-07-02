/**
 * Legacy Timesheets shell — kept as a thin wrapper for old in-app imports.
 * The real workspace lives under /timesheets/* (see src/apps/timesheets/routes).
 *
 * IMPORTANT: This file no longer wraps in DashboardLayout — the
 * AppWorkspaceLayout in routes.tsx already provides the chrome and
 * full-width container.
 */
import MyTimesheets from "./MyTimesheets";

export default function Timesheets() {
  return <MyTimesheets />;
}

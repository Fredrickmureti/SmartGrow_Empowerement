/**
 * hr-suite-consistency.test.ts — guards the cross-app UX parity wave.
 *
 * Asserts the HR sub-apps (Attendance / Time Off / Timesheets) and the
 * /me/* portal share the same primitives so a user walking between them
 * keeps the same mental model:
 *
 *  - Each HR sub-app mounts its own grouped SubNav.
 *  - The three /me/* operational pages (attendance, timesheets, leave)
 *    all surface the shared <ManagerTriageBanner>.
 *  - /me/leave uses the purpose-built MyLeave portal page, NOT the
 *    admin-flavoured LeaveDashboard.
 *  - The shared primitives (ManagerTriageBanner, useListHotkeys, inbox
 *    counts hooks) exist on disk.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../../..");
const r = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("HR suite consistency", () => {
  it("shared primitives are on disk", () => {
    expect(existsSync(resolve(ROOT, "src/components/hr/ManagerTriageBanner.tsx"))).toBe(true);
    expect(existsSync(resolve(ROOT, "src/hooks/hr/useListHotkeys.ts"))).toBe(true);
    expect(existsSync(resolve(ROOT, "src/hooks/leave/useLeaveInboxCounts.ts"))).toBe(true);
    expect(existsSync(resolve(ROOT, "src/hooks/timesheets/useTimesheetInboxCounts.ts"))).toBe(true);
  });

  it("each HR sub-app mounts the new PlatformShell with its WorkspaceNav", () => {
    // Navigation overhaul: legacy *SubNav horizontal strips replaced by a
    // grouped left sidebar driven by PlatformShell + a per-app WorkspaceNav.
    const time = r("src/apps/hr/sub/TimeOffRoutes.tsx");
    expect(time).toMatch(/from\s+"@\/components\/layout\/shell\/PlatformShell"/);
    expect(time).toMatch(/<PlatformShell\b[^>]*nav=\{TIME_OFF_NAV\}/);
    expect(time).not.toMatch(/<LeaveSubNav\b/);

    const ts = r("src/apps/timesheets/routes.tsx");
    expect(ts).toMatch(/from\s+"@\/components\/layout\/shell\/PlatformShell"/);
    expect(ts).toMatch(/<PlatformShell\b[^>]*nav=\{TIMESHEETS_NAV\}/);
    expect(ts).not.toMatch(/<TimesheetsSubNav\b/);

    const att = r("src/apps/hr/sub/AttendanceRoutes.tsx");
    expect(att).toMatch(/from\s+"@\/components\/layout\/shell\/PlatformShell"/);
    expect(att).toMatch(/<PlatformShell\b[^>]*nav=\{ATTENDANCE_NAV\}/);
    expect(att).not.toMatch(/<AttendanceSubNav\b/);

    const emp = r("src/apps/hr/sub/EmployeesRoutes.tsx");
    expect(emp).toMatch(/from\s+"@\/components\/layout\/shell\/PlatformShell"/);
    expect(emp).toMatch(/<PlatformShell\b[^>]*nav=\{EMPLOYEES_NAV\}/);
    expect(emp).not.toMatch(/<EmployeesSubNav\b/);
  });

  it("Time-off admin routes own dedicated Approvals + Calendar pages", () => {
    expect(existsSync(resolve(ROOT, "src/pages/leave/LeaveApprovals.tsx"))).toBe(true);
    expect(existsSync(resolve(ROOT, "src/pages/leave/LeaveCalendar.tsx"))).toBe(true);
    const routes = r("src/apps/hr/sub/TimeOffRoutes.tsx");
    expect(routes).toMatch(/path="approvals"/);
    expect(routes).toMatch(/path="calendar"/);
  });

  it("/me/leave is the purpose-built portal page, not the admin dashboard", () => {
    expect(existsSync(resolve(ROOT, "src/pages/me/MyLeave.tsx"))).toBe(true);
    const meApp = r("src/apps/me/MeApp.tsx");
    expect(meApp).toMatch(/import\("@\/pages\/me\/MyLeave"\)/);
    expect(meApp).toMatch(/<MyLeave\s*\/>/);
    // The admin-flavoured LeaveDashboard must not be lazy-imported here any more.
    expect(meApp).not.toMatch(/import\("@\/pages\/leave\/LeaveDashboard"\)/);
  });

  it("all three /me operational pages surface ManagerTriageBanner", () => {
    const att = r("src/pages/me/MyAttendance.tsx");
    const ts = r("src/pages/timesheets/MyTimesheets.tsx");
    const lv = r("src/pages/me/MyLeave.tsx");
    expect(att).toMatch(/ManagerTriageBanner/);
    expect(ts).toMatch(/ManagerTriageBanner/);
    expect(lv).toMatch(/ManagerTriageBanner/);

    // Each invocation passes the matching module prop.
    expect(att).toMatch(/module="attendance"/);
    expect(ts).toMatch(/module="timesheets"/);
    expect(lv).toMatch(/module="leave"/);
  });

  it("ManagerTriageBanner supports the three HR modules", () => {
    const src = r("src/components/hr/ManagerTriageBanner.tsx");
    expect(src).toMatch(/attendance:/);
    expect(src).toMatch(/timesheets:/);
    expect(src).toMatch(/leave:/);
  });

  it("MyLeave uses portal-friendly primitives (no admin export/settings)", () => {
    const src = r("src/pages/me/MyLeave.tsx");
    // Portal page must NOT import the org-wide export buttons or the
    // leave-type settings dialog — those are HR admin surfaces.
    expect(src).not.toMatch(/ReportExportButtons/);
    expect(src).not.toMatch(/LeaveTypeSettingsDialog/);
    // Must offer the self-service primary CTA.
    expect(src).toMatch(/Request leave/);
  });
});

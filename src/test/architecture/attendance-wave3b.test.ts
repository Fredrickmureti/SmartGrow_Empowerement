/**
 * Wave 3b architecture guard — pins the mount-points for the saved-views
 * primitive, the approvals hotkeys hook, the team-scope trend drawer,
 * the renamed sub-nav labels, the /hr/attendance/team redirect, and the
 * /me/attendance Today/History split + manager triage banner.
 *
 * File-text assertions only (same style as approvals-redirects.test.ts).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string) =>
  readFileSync(resolve(__dirname, "../..", rel), "utf8");

describe("Attendance Wave 3b — mounts", () => {
  it("HR Today mounts SavedViewMenu and EmployeeTrendDrawer", () => {
    const src = read("pages/hr/Attendance.tsx");
    expect(src).toMatch(/from "@\/components\/attendance\/SavedViewMenu"/);
    expect(src).toMatch(/<SavedViewMenu[\s\S]+?scope="today"/);
    expect(src).toMatch(/from "@\/components\/attendance\/EmployeeTrendDrawer"/);
    expect(src).toMatch(/<EmployeeTrendDrawer/);
  });

  it("Approvals page mounts SavedViewMenu and approvals hotkeys", () => {
    const src = read("pages/hr/AttendanceApprovals.tsx");
    expect(src).toMatch(/from "@\/components\/attendance\/SavedViewMenu"/);
    expect(src).toMatch(/scope="approvals"/);
    expect(src).toMatch(/from "@\/hooks\/hr\/useApprovalsHotkeys"/);
    expect(src.match(/useApprovalsHotkeys\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // Keyboard cheatsheet visible to managers
    expect(src).toMatch(/J\/K/);
  });

  it("Reports page mounts SavedViewMenu and the Hide-acknowledged toggle", () => {
    const src = read("pages/hr/AttendanceReports.tsx");
    expect(src).toMatch(/from "@\/components\/attendance\/SavedViewMenu"/);
    expect(src).toMatch(/scope="reports"/);
    expect(src).toMatch(/Hide acknowledged exceptions/);
    expect(src).toMatch(/anomaly_ack_codes/);
  });

  it("Sub-nav uses the Inbox / Activity log vocabulary and no longer lists 'My Team'", () => {
    const src = read("components/attendance/AttendanceSubNav.tsx");
    expect(src).toMatch(/Inbox/);
    expect(src).toMatch(/Activity log/);
    expect(src).not.toMatch(/label:\s*"My Team"/);
  });

  it("/hr/attendance/team is still redirected into Today via ?scope=team", () => {
    const src = read("apps/hr/sub/AttendanceRoutes.tsx");
    expect(src).toMatch(/function RedirectTeamToToday/);
    expect(src).toMatch(/params\.set\("scope", "team"\)/);
  });

  it("/me/attendance splits into Today/History and shows the manager triage banner", () => {
    const src = read("pages/me/MyAttendance.tsx");
    expect(src).toMatch(/from "@\/hooks\/hr\/useAttendanceInboxCounts"/);
    expect(src).toMatch(/<Tabs/);
    expect(src).toMatch(/value="today"/);
    expect(src).toMatch(/value="history"/);
    expect(src).toMatch(/team item/);
  });

  it("AnomalyBadge exposes per-code Acknowledge wired to attendance_anomaly_ack", () => {
    const src = read("components/attendance/AnomalyBadge.tsx");
    expect(src).toMatch(/attendance_anomaly_ack/);
    expect(src).toMatch(/Acknowledge/);
    expect(src).toMatch(/attendanceId\?:\s*string/);
  });
});

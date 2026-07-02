/**
 * Cross-module UX parity guard (B5 — Attendance/Timesheets/Time-off).
 *
 * Verifies that the chrome and "work waiting" primitives introduced for
 * Attendance now extend to Timesheets and Time-off so users don't jump from
 * a clean module to a cluttered one.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../../..");
const r = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("Cross-module UX parity (B5)", () => {
  it("ships the three sub-navs, three inbox-count hooks, and the generalized inbox card", () => {
    expect(existsSync(resolve(ROOT, "src/components/attendance/AttendanceSubNav.tsx"))).toBe(true);
    expect(existsSync(resolve(ROOT, "src/components/timesheets/TimesheetsSubNav.tsx"))).toBe(true);
    expect(existsSync(resolve(ROOT, "src/components/leave/LeaveSubNav.tsx"))).toBe(true);
    expect(existsSync(resolve(ROOT, "src/hooks/hr/useAttendanceInboxCounts.ts"))).toBe(true);
    expect(existsSync(resolve(ROOT, "src/hooks/timesheets/useTimesheetInboxCounts.ts"))).toBe(true);
    expect(existsSync(resolve(ROOT, "src/hooks/leave/useLeaveInboxCounts.ts"))).toBe(true);
    expect(existsSync(resolve(ROOT, "src/components/hr/ModuleInboxCard.tsx"))).toBe(true);
  });

  it("Timesheets routes mount the new PlatformShell with TIMESHEETS_NAV", () => {
    const src = r("src/apps/timesheets/routes.tsx");
    expect(src).toMatch(/from\s+"@\/components\/layout\/shell\/PlatformShell"/);
    expect(src).toMatch(/<PlatformShell\b[^>]*nav=\{TIMESHEETS_NAV\}/);
  });

  it("Time-off routes mount the new PlatformShell with TIME_OFF_NAV", () => {
    const src = r("src/apps/hr/sub/TimeOffRoutes.tsx");
    expect(src).toMatch(/from\s+"@\/components\/layout\/shell\/PlatformShell"/);
    expect(src).toMatch(/<PlatformShell\b[^>]*nav=\{TIME_OFF_NAV\}/);
  });

  it("HR dashboard surfaces all three inbox cards via the unified strip", () => {
    const src = r("src/pages/hr/HRDashboard.tsx");
    expect(src).toMatch(/from\s+"@\/components\/hr\/ModuleInboxCard"/);
    expect(src).toMatch(/<ModuleInboxStrip/);
    // The strip itself must still wire all three modules.
    const strip = r("src/components/hr/ModuleInboxCard.tsx");
    expect(strip).toMatch(/module="attendance"/);
    expect(strip).toMatch(/module="timesheets"/);
    expect(strip).toMatch(/module="leave"/);
  });


  it("MyAttendance gates the manager triage banner on manageAttendance", () => {
    const src = r("src/pages/me/MyAttendance.tsx");
    expect(src).toMatch(/usePermissions/);
    expect(src).toMatch(/can\(["']manageAttendance["']\)/);
    expect(src).toMatch(/canManageAttendance && inboxCounts\.total > 0/);
  });

  it("AttendanceSubNav Setup dropdown no longer double-renders the device badge", () => {
    const src = r("src/components/attendance/AttendanceSubNav.tsx");
    // Trigger still shows the badge; the dropdown body should NOT.
    const body = src.split("<DropdownMenuContent")[1]?.split("</DropdownMenuContent>")[0] ?? "";
    expect(body).not.toMatch(/counts\.devicesDisabled\s*>\s*0/);
  });


  it("ModuleInboxCard wires the three inbox hooks", () => {
    const src = r("src/components/hr/ModuleInboxCard.tsx");
    expect(src).toMatch(/useAttendanceInboxCounts/);
    expect(src).toMatch(/useTimesheetInboxCounts/);
    expect(src).toMatch(/useLeaveInboxCounts/);
  });

  // ---- B6 finish-pass guards ----

  it("Time-off admin routes are split (Overview, Approvals, Calendar, Allocations)", () => {
    const src = r("src/apps/hr/sub/TimeOffRoutes.tsx");
    expect(src).toMatch(/path="approvals"/);
    expect(src).toMatch(/path="calendar"/);
    expect(src).toMatch(/path="allocations"/);
    expect(src).toMatch(/import\("@\/pages\/leave\/LeaveApprovals"\)/);
    expect(src).toMatch(/import\("@\/pages\/leave\/LeaveCalendar"\)/);
    // Legacy ?tab=… deep links continue to redirect.
    expect(src).toMatch(/LegacyTabRedirect/);
  });

  it("LeaveSubNav links to the new dedicated routes (no ?tab= dead nav)", () => {
    const src = r("src/components/leave/LeaveSubNav.tsx");
    expect(src).toMatch(/\/hr\/leave\/approvals/);
    expect(src).toMatch(/\/hr\/leave\/calendar/);
    expect(src).toMatch(/\/hr\/leave\/allocations/);
    expect(src).not.toMatch(/tab=approvals/);
    expect(src).not.toMatch(/tab=team-calendar/);
  });

  it("TimesheetsSubNav exposes a single Approvals destination (B6.2 dedupe)", () => {
    const src = r("src/components/timesheets/TimesheetsSubNav.tsx");
    // The legacy duplicate Inbox/Pending entry pointing at /timesheets/approvals is gone.
    expect(src).not.toMatch(/\/timesheets\/approvals/);
    // Operations item still carries the inbox badge.
    expect(src).toMatch(/label:\s*"Approvals"[\s\S]{0,80}badge:\s*inbox/);
  });

  it("HRDashboard inbox strip collapses to an All-clear state when every queue is empty (B6.9)", () => {
    const src = r("src/components/hr/ModuleInboxCard.tsx");
    expect(src).toMatch(/export function ModuleInboxStrip/);
    expect(src).toMatch(/All inboxes clear/);
  });
});


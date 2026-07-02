/**
 * attendance-reaudit.test.ts — guards for the re-audit wave that follows
 * the previous Attendance closure work. Asserts the user-visible
 * changes the plan committed to so they don't silently regress.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");

describe("Attendance re-audit guards", () => {
  it("AttendanceApprovals supports bulk selection and approve", () => {
    const src = read("pages/hr/AttendanceApprovals.tsx");
    expect(src).toMatch(/from "@\/components\/ui\/checkbox"/);
    expect(src).toMatch(/Select all/);
    // Bulk fan-out RPCs:
    expect(src).toMatch(/attendance_approve_correction/);
    expect(src).toMatch(/overtime_request_decide/);
    expect(src).toMatch(/Promise\.allSettled/);
  });

  it("Today page exposes a My Team filter pill, Clear filters CTA, and bulk admin ops", () => {
    const src = read("pages/hr/Attendance.tsx");
    expect(src).toMatch(/My team/);
    expect(src).toMatch(/useCurrentEmployee/);
    expect(src).toMatch(/Clear filters/);
    // Bulk admin operations wired:
    expect(src).toMatch(/attendance_admin_close_session/);
    expect(src).toMatch(/attendance_admin_mark_absent/);
    expect(src).toMatch(/Close stale sessions/);
    expect(src).toMatch(/Mark absent/);
  });

  it("AttendanceAudit no longer imports the duplicated LivePresenceCard", () => {
    const src = read("pages/hr/AttendanceAudit.tsx");
    expect(src).not.toMatch(/^import\s*\{\s*LivePresenceCard\s*\}/m);
    expect(src).not.toMatch(/<LivePresenceCard\s*\/>/);
    // Keeps a hint pointer to Today so the surface is still discoverable.
    expect(src).toMatch(/See live presence on Today/);
  });

  it("AttendanceReports collapses to 3 top-level tabs", () => {
    const src = read("pages/hr/AttendanceReports.tsx");
    // The three canonical top-level tabs.
    expect(src).toMatch(/TabsTrigger value="exceptions"/);
    expect(src).toMatch(/TabsTrigger value="hours"/);
    expect(src).toMatch(/TabsTrigger value="summary"/);
    // The 8 legacy flat triggers must not all be present at the top.
    expect(src).not.toMatch(/TabsTrigger value="late"/);
    expect(src).not.toMatch(/TabsTrigger value="missing"/);
  });

  it("AttendanceSettingsPage groups its surface into tabs", () => {
    const src = read("pages/hr/AttendanceSettingsPage.tsx");
    expect(src).toMatch(/from "@\/components\/ui\/tabs"/);
    expect(src).toMatch(/TabsTrigger value="general"/);
    expect(src).toMatch(/TabsTrigger value="policies"/);
    expect(src).toMatch(/TabsTrigger value="trust"/);
    expect(src).toMatch(/TabsTrigger value="kiosk"/);
  });

  it("MyAttendanceCalendar enables blank-day correction requests", () => {
    const src = read("components/attendance/MyAttendanceCalendar.tsx");
    expect(src).toMatch(/onRequestBlankCorrection/);
    // The hard-disabled-when-no-record path is gone.
    expect(src).not.toMatch(/disabled=\{!record\}/);
  });

  it("MyAttendance renders the new summary tile", () => {
    expect(existsSync(resolve(__dirname, "../../components/attendance/MyAttendanceSummaryTile.tsx"))).toBe(true);
    const src = read("pages/me/MyAttendance.tsx");
    expect(src).toMatch(/MyAttendanceSummaryTile/);
  });

  it("AttendanceClockWidget labels OT trigger clearly", () => {
    const src = read("components/attendance/AttendanceClockWidget.tsx");
    expect(src).toMatch(/Request OT/);
    // The bare "Overtime" button label must be gone (dialog title is allowed).
    expect(src).not.toMatch(/>\s*Overtime\s*</);
  });
});

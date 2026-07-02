/**
 * attendance-wave-b7.test.ts — guards for the B7 enterprise-WFM wave.
 * Each assertion pins a user-visible change so future edits cannot
 * silently regress the workflow.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
const has = (p: string) => existsSync(resolve(__dirname, "../..", p));

describe("Attendance B7 — enterprise gap closure", () => {
  it("B7.1 /me Today renders MyDayProgressCard instead of three weekly tiles", () => {
    expect(has("components/attendance/MyDayProgressCard.tsx")).toBe(true);
    const src = read("pages/me/MyAttendance.tsx");
    expect(src).toMatch(/MyDayProgressCard/);
    // The three duplicate weekly tiles are gone.
    expect(src).not.toMatch(/grid grid-cols-2 md:grid-cols-3 gap-3/);
  });

  it("B7.2 /me Today surfaces recent request decisions", () => {
    expect(has("components/attendance/MyRequestDecisions.tsx")).toBe(true);
    const src = read("pages/me/MyAttendance.tsx");
    expect(src).toMatch(/MyRequestDecisions/);
  });

  it("B7.3 LateReasonDialog wired into AttendanceClockWidget post-clock-in", () => {
    expect(has("components/attendance/LateReasonDialog.tsx")).toBe(true);
    const dlg = read("components/attendance/LateReasonDialog.tsx");
    expect(dlg).toMatch(/late_reason/);
    // The widget must import the dialog AND drive it from clockInAsync so the
    // post-clock-in branch can read late_minutes from the new row.
    const widget = read("components/attendance/AttendanceClockWidget.tsx");
    expect(widget).toMatch(/LateReasonDialog/);
    expect(widget).toMatch(/clockInAsync/);
    expect(widget).toMatch(/require_late_reason/);
    expect(widget).toMatch(/late_minutes/);
  });

  it("B7.5 device health helper + inbox row + stale filter wired end-to-end", () => {
    expect(has("lib/attendance/deviceHealth.ts")).toBe(true);
    const hookSrc = read("hooks/hr/useAttendanceInboxCounts.ts");
    expect(hookSrc).toMatch(/devicesStale/);
    const cardSrc = read("components/attendance/AttendanceInboxCard.tsx");
    expect(cardSrc).toMatch(/Devices silent >24h/);
    expect(cardSrc).toMatch(/filter=stale/);
    // Devices page must honor ?filter=stale + render the health badge.
    const dev = read("pages/hr/AttendanceDevices.tsx");
    expect(dev).toMatch(/useSearchParams/);
    expect(dev).toMatch(/filter === "stale"/);
    expect(dev).toMatch(/deviceHealthBadgeClass/);
    expect(dev).toMatch(/EmptyStateRail/);
  });

  it("B7.6 BranchesGlanceStrip mounted on Attendance manager page", () => {
    expect(has("components/attendance/BranchesGlanceStrip.tsx")).toBe(true);
    const strip = read("components/attendance/BranchesGlanceStrip.tsx");
    expect(strip).toMatch(/switchBranch/);
    expect(strip).toMatch(/branches\.length < 2/);
    const page = read("pages/hr/Attendance.tsx");
    expect(page).toMatch(/BranchesGlanceStrip/);
    expect(page).toMatch(/totalsByBranch/);
  });

  it("B7.7 ClosePeriodDialog mounted + gated on manageAttendance", () => {
    expect(has("components/attendance/ClosePeriodDialog.tsx")).toBe(true);
    const dlg = read("components/attendance/ClosePeriodDialog.tsx");
    expect(dlg).toMatch(/attendance_close_period/);
    const page = read("pages/hr/Attendance.tsx");
    expect(page).toMatch(/ClosePeriodDialog/);
    expect(page).toMatch(/Close period/);
    expect(page).toMatch(/setShowCloseDialog/);
  });

  it("B7.8 EmptyStateRail primitive exists and is adopted by Devices", () => {
    expect(has("components/attendance/EmptyStateRail.tsx")).toBe(true);
    const dev = read("pages/hr/AttendanceDevices.tsx");
    expect(dev).toMatch(/EmptyStateRail/);
  });
});

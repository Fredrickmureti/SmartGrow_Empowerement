/**
 * Finish-pass guards for the Attendance UX overhaul.
 *
 *  1. EmployeeDayDrawer is wired into Reports and Audit (Phase 5 finish).
 *  2. Legacy AttendanceCorrections / AttendanceOvertimeRequests pages are
 *     deleted (replaced by the unified /approvals hub).
 *  3. AttendanceInboxCard links to the canonical /approvals?tab=… URLs,
 *     not the legacy /corrections and /overtime aliases.
 *  4. AttendanceClockWidget surfaces the OT request as a real, peer-sized
 *     button next to Clock In/Out (not buried in a ghost link).
 *  5. MyAttendanceCalendar surfaces day-level anomalies to the employee.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../../..");
const r = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("Attendance — finish pass", () => {
  it("Reports page wires the canonical EmployeeDayDrawer", () => {
    const src = r("src/pages/hr/AttendanceReports.tsx");
    expect(src).toMatch(/from\s+"@\/components\/attendance\/EmployeeDayDrawer"/);
    expect(src).toMatch(/<EmployeeDayDrawer\b/);
    expect(src).toMatch(/onRowClick=\{openDrawer\}/);
  });

  it("Audit page opens the EmployeeDayDrawer (via lookup helper) from event rows", () => {
    const src = r("src/pages/hr/AttendanceAudit.tsx");
    expect(src).toMatch(/EmployeeDayDrawerByLookup/);
    expect(src).toMatch(/setDrawerTarget\(\{/);
  });

  it("orphaned legacy pages are deleted", () => {
    expect(existsSync(resolve(ROOT, "src/pages/hr/AttendanceCorrections.tsx"))).toBe(false);
    expect(existsSync(resolve(ROOT, "src/pages/hr/AttendanceOvertimeRequests.tsx"))).toBe(false);
  });

  it("AttendanceInboxCard links to canonical /approvals?tab=… URLs", () => {
    const src = r("src/components/attendance/AttendanceInboxCard.tsx");
    expect(src).toMatch(/\/hr\/attendance\/approvals\?tab=corrections/);
    expect(src).toMatch(/\/hr\/attendance\/approvals\?tab=overtime/);
    // Legacy alias URLs must NOT be used as link targets here.
    expect(src).not.toMatch(/to:\s*"\/hr\/attendance\/corrections"/);
    expect(src).not.toMatch(/to:\s*"\/hr\/attendance\/overtime"/);
  });

  it("AttendanceClockWidget keeps Request overtime as a real, peer-sized button", () => {
    const src = r("src/components/attendance/AttendanceClockWidget.tsx");
    // Real Button (not a link/text), sized like Clock In/Out (size="lg").
    expect(src).toMatch(/setOtOpen\(true\)[\s\S]{0,200}size="lg"/);
  });

  it("MyAttendanceCalendar surfaces day-level anomalies", () => {
    const src = r("src/components/attendance/MyAttendanceCalendar.tsx");
    expect(src).toMatch(/detectAnomalies/);
    expect(src).toMatch(/AlertTriangle/);
  });
});

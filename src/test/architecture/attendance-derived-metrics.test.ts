/**
 * Odoo-style derived attendance metrics — architecture guards.
 *
 * Locks the new contract: headline Present/Late/Absent/On-leave must derive
 * from the existence of an attendance line + leave/holiday joins
 * (`useAttendanceDaySummary`), NEVER from counting `attendance.status`
 * literals. The old `records.filter(r => r.status === 'present')` pattern
 * produced 0 for open sessions and 0 for employees with no row.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const useAttendance = readFileSync(resolve(ROOT, "hooks/useAttendance.ts"), "utf8");
const attendancePage = readFileSync(resolve(ROOT, "pages/hr/Attendance.tsx"), "utf8");
const summaryHook = readFileSync(resolve(ROOT, "hooks/hr/useAttendanceDaySummary.ts"), "utf8");
const kpiStrip = readFileSync(resolve(ROOT, "components/attendance/AttendanceKpiStrip.tsx"), "utf8");

describe("Attendance — Odoo derived metrics", () => {
  it("useAttendance no longer exports status-based presentToday/absentToday/lateToday", () => {
    expect(useAttendance).not.toMatch(/\bpresentToday\b/);
    expect(useAttendance).not.toMatch(/\babsentToday\b/);
    expect(useAttendance).not.toMatch(/\blateToday\b/);
    expect(useAttendance).not.toMatch(/r\.status\s*===\s*["']present["']/);
    expect(useAttendance).not.toMatch(/r\.status\s*===\s*["']absent["']/);
  });

  it("useAttendanceDaySummary defines the derived contract", () => {
    expect(summaryHook).toMatch(/presentEmployeeIds/);
    expect(summaryHook).toMatch(/onLeaveEmployeeIds/);
    expect(summaryHook).toMatch(/holidayEmployeeIds/);
    expect(summaryHook).toMatch(/lateRecords/);
    expect(summaryHook).toMatch(/absentCount/);
    // Joins leave_requests + public_holidays for the derived sets.
    expect(summaryHook).toMatch(/leave_requests/);
    expect(summaryHook).toMatch(/public_holidays/);
  });

  it("Attendance.tsx consumes the summary hook for KPIs and chip counts", () => {
    expect(attendancePage).toMatch(/useAttendanceDaySummary/);
    // Filter chips are bound to derived sets, not raw status counts.
    expect(attendancePage).toMatch(/summary\.presentEmployeeIds/);
    expect(attendancePage).toMatch(/summary\.onLeaveEmployeeIds/);
    expect(attendancePage).toMatch(/summary\.lateRecords/);
    // KPI strip receives the derived numbers.
    expect(attendancePage).toMatch(/present=\{summary\.presentCount\}/);
    expect(attendancePage).toMatch(/absent=\{summary\.absentCount\}/);
    expect(attendancePage).toMatch(/onLeave=\{summary\.onLeaveCount\}/);
  });

  it("KPI strip supports an On-leave tile", () => {
    expect(kpiStrip).toMatch(/onLeave\??:/);
    expect(kpiStrip).toMatch(/On leave/);
  });
});

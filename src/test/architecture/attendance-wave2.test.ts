/**
 * Wave 2 architecture guards — assert the user-visible deliverables of
 * the Wave 2 plan exist in source so they don't silently regress.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");

describe("Attendance Wave-2 guards", () => {
  it("Manager command-center page and route exist", () => {
    expect(
      existsSync(resolve(__dirname, "../../pages/hr/AttendanceMyTeam.tsx")),
    ).toBe(true);
    const routes = read("apps/hr/sub/AttendanceRoutes.tsx");
    expect(routes).toMatch(/AttendanceMyTeam/);
    expect(routes).toMatch(/path="team"/);
  });

  it("Sub-nav surfaces My Team only for managers", () => {
    const subnav = read("components/attendance/AttendanceSubNav.tsx");
    expect(subnav).toMatch(/useCurrentEmployee/);
    expect(subnav).toMatch(/isManager/);
    expect(subnav).toMatch(/My Team/);
  });

  it("Inbox counts hook subscribes to realtime postgres_changes", () => {
    const src = read("hooks/hr/useAttendanceInboxCounts.ts");
    expect(src).toMatch(/postgres_changes/);
    expect(src).toMatch(/attendance_corrections/);
    expect(src).toMatch(/overtime_requests/);
    expect(src).toMatch(/removeChannel/);
  });

  it("AnomalyBadge is clickable and renders an explanation popover", () => {
    const src = read("components/attendance/AnomalyBadge.tsx");
    expect(src).toMatch(/from "@\/components\/ui\/popover"/);
    expect(src).toMatch(/Popover/);
    expect(src).toMatch(/Why this is flagged/);
    expect(src).toMatch(/Adjust settings/);
  });

  it("Pattern strip exists and is mounted on Reports", () => {
    expect(
      existsSync(
        resolve(__dirname, "../../components/attendance/AttendancePatternStrip.tsx"),
      ),
    ).toBe(true);
    const reports = read("pages/hr/AttendanceReports.tsx");
    expect(reports).toMatch(/AttendancePatternStrip/);
  });

  it("Audit page exposes a Violations-only filter", () => {
    const src = read("pages/hr/AttendanceAudit.tsx");
    expect(src).toMatch(/VIOLATION_CODES/);
    expect(src).toMatch(/Violations only/);
    expect(src).toMatch(/violationsOnly/);
  });

  it("/me/attendance reorders for mobile (sticky clock above the fold)", () => {
    const src = read("pages/me/MyAttendance.tsx");
    expect(src).toMatch(/sticky/);
    expect(src).toMatch(/AttendanceClockWidget/);
  });

  it("Notification helper + triggers exist in a wave-2 migration", () => {
    const dir = resolve(__dirname, "../../../supabase/migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    const combined = files
      .map((f) => readFileSync(resolve(dir, f), "utf8"))
      .join("\n");
    expect(combined).toMatch(/notify_attendance_decision/);
    expect(combined).toMatch(/trg_notify_correction_decision/);
    expect(combined).toMatch(/trg_notify_overtime_decision/);
  });
});
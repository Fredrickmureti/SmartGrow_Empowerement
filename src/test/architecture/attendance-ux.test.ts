/**
 * Architecture guard for the Attendance UX overhaul.
 *
 *  - Sub-nav lives in its own component (AttendanceSubNav.tsx) and is grouped.
 *  - Routes file no longer hand-rolls a 10-item flat NavLink list.
 *  - Kiosk is NOT a sub-nav entry (it's a chrome-less launcher under Setup).
 *  - Inbox counts come from a single hook (useAttendanceInboxCounts).
 *  - Attendance.tsx command center renders the new primitives and drops
 *    the inner Tabs control + the duplicated header "Corrections" button.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../../..");
const r = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("Attendance UX overhaul", () => {
  it("ships the dedicated sub-nav, inbox card, KPI strip, and inbox-counts hook", () => {
    expect(existsSync(resolve(ROOT, "src/components/attendance/AttendanceSubNav.tsx"))).toBe(true);
    expect(existsSync(resolve(ROOT, "src/components/attendance/AttendanceInboxCard.tsx"))).toBe(true);
    expect(existsSync(resolve(ROOT, "src/components/attendance/AttendanceKpiStrip.tsx"))).toBe(true);
    expect(existsSync(resolve(ROOT, "src/hooks/hr/useAttendanceInboxCounts.ts"))).toBe(true);
  });

  it("AttendanceRoutes now mounts the PlatformShell sidebar and drops the kiosk tab", () => {
    const src = r("src/apps/hr/sub/AttendanceRoutes.tsx");
    // Navigation overhaul: AttendanceSubNav strip is retired in favour of
    // the shared PlatformShell + ATTENDANCE_NAV grouped left sidebar.
    expect(src).toMatch(/from\s+"@\/components\/layout\/shell\/PlatformShell"/);
    expect(src).toMatch(/<PlatformShell\b[^>]*nav=\{ATTENDANCE_NAV\}/);
    // The legacy in-shell /kiosk route stays absent
    expect(src).not.toMatch(/path=\s*["']kiosk["']/);
  });

  it("AttendanceSubNav groups items and collapses Approvals into one entry", () => {
    const src = r("src/components/attendance/AttendanceSubNav.tsx");
    expect(src).toMatch(/label:\s*"Operations"/);
    expect(src).toMatch(/label:\s*"Approvals"/);
    expect(src).toMatch(/label:\s*"Insights"/);
    expect(src).toMatch(/DropdownMenu/);
    expect(src).toMatch(/Open Kiosk/);
    expect(src).toMatch(/useAttendanceInboxCounts/);
    // Approvals is a single item now, not split into corrections + overtime.
    expect(src).toMatch(/\/hr\/attendance\/approvals/);
    expect(src).not.toMatch(/to:\s*"\/hr\/attendance\/corrections"/);
    expect(src).not.toMatch(/to:\s*"\/hr\/attendance\/overtime"/);
  });

  it("Attendance.tsx is the command center: KPI strip, presence popover, approvals chip", () => {
    const src = r("src/pages/hr/Attendance.tsx");
    expect(src).toMatch(/AttendanceKpiStrip/);
    expect(src).toMatch(/LivePresenceCard/);
    expect(src).toMatch(/EmployeeDayDrawer/);
    expect(src).toMatch(/StatusFilterChips/);
    // The hand-rolled inner Overview/Team Log Tabs is gone
    expect(src).not.toMatch(/TabsTrigger\s+value=["']overview["']/);
    expect(src).not.toMatch(/TabsTrigger\s+value=["']team["']/);
    // Approvals is the canonical destination, not the legacy /corrections.
    expect(src).toMatch(/\/hr\/attendance\/approvals/);
    // Self-clock widget is no longer mounted in the manager overview
    expect(src).not.toMatch(/<AttendanceClockWidget/);
  });
});


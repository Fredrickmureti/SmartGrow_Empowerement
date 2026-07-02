/**
 * cross-module-ux-parity-wave-b.test.ts — Wave B + C architecture guards.
 *
 * Pin the new HR-wide primitives (KpiStrip, ManagerTriageBanner,
 * useListHotkeys) and their mount points so the chrome users see on
 * Attendance carries through Timesheets and the /me portals.
 *
 * Intentionally a separate file from the B5/B6 parity guards so we don't
 * destabilize the existing 7 assertions.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../../..");
const r = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const has = (p: string) => existsSync(resolve(ROOT, p));

describe("Cross-module UX parity — Wave B/C", () => {
  it("ships the shared HR primitives (KpiStrip, ManagerTriageBanner, useListHotkeys)", () => {
    expect(has("src/components/hr/KpiStrip.tsx")).toBe(true);
    expect(has("src/components/hr/ManagerTriageBanner.tsx")).toBe(true);
    expect(has("src/hooks/hr/useListHotkeys.ts")).toBe(true);
  });

  it("ManagerTriageBanner is module-driven and wired to all three inbox hooks", () => {
    const src = r("src/components/hr/ManagerTriageBanner.tsx");
    expect(src).toMatch(/useAttendanceInboxCounts/);
    expect(src).toMatch(/useTimesheetInboxCounts/);
    expect(src).toMatch(/useLeaveInboxCounts/);
    expect(src).toMatch(/module:\s*TriageModule/);
  });

  it("Timesheet approvals adopt the KpiStrip and surface team totals", () => {
    const src = r("src/pages/timesheets/TimesheetApprovals.tsx");
    expect(src).toMatch(/from\s+"@\/components\/hr\/KpiStrip"/);
    expect(src).toMatch(/<KpiStrip/);
  });

  it("Team timesheets header adopts the KpiStrip", () => {
    const src = r("src/pages/timesheets/TeamTimesheets.tsx");
    expect(src).toMatch(/from\s+"@\/components\/hr\/KpiStrip"/);
    expect(src).toMatch(/<KpiStrip/);
  });

  it("MyTimesheets mounts the manager triage banner", () => {
    const src = r("src/pages/timesheets/MyTimesheets.tsx");
    expect(src).toMatch(/ManagerTriageBanner/);
    expect(src).toMatch(/module="timesheets"/);
  });

  it("MyAttendance uses the shared ManagerTriageBanner (no inline duplicate)", () => {
    const src = r("src/pages/me/MyAttendance.tsx");
    expect(src).toMatch(/ManagerTriageBanner/);
    expect(src).toMatch(/module="attendance"/);
    // The hand-rolled amber div is gone.
    expect(src).not.toMatch(/Inbox className="h-4 w-4 text-amber-700/);
  });

  it("Shifts admin page surfaces EmptyStateRail when no shifts exist", () => {
    const src = r("src/pages/hr/Shifts.tsx");
    expect(src).toMatch(/EmptyStateRail/);
    expect(src).toMatch(/No shifts yet/);
  });

  it("useListHotkeys mirrors the J/K/A/R/X/Esc shortcuts of useApprovalsHotkeys", () => {
    const src = r("src/hooks/hr/useListHotkeys.ts");
    for (const key of ['"j"', '"ArrowDown"', '"k"', '"ArrowUp"', '"a"', '"r"', '"x"', '"Escape"']) {
      expect(src).toMatch(new RegExp(key));
    }
  });
});

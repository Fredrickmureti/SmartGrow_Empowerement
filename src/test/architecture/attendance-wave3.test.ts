/**
 * Wave 3 architecture guards.
 *
 * These ensure the user-visible deliverables of the Wave 3 plan stay
 * present:
 *   1. RejectReasonDialog exists and is wired into Approvals for both
 *      bulk corrections, bulk overtime, and single overtime rejects.
 *   2. MyWeekStrip exists and is mounted on /me/attendance.
 *   3. NotificationItem has a category icon for `attendance` so
 *      decision notifications are visually distinct.
 *   4. Kiosk standalone references the idle-lock timer.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../../..");
const r = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("Attendance Wave 3 — reject-reason, week strip, notif icon, kiosk lock", () => {
  it("RejectReasonDialog component exists", () => {
    expect(
      existsSync(resolve(ROOT, "src/components/attendance/RejectReasonDialog.tsx")),
    ).toBe(true);
  });

  it("AttendanceApprovals imports and uses RejectReasonDialog", () => {
    const src = r("src/pages/hr/AttendanceApprovals.tsx");
    expect(src).toMatch(/from\s+"@\/components\/attendance\/RejectReasonDialog"/);
    // Both bulk-reject buttons go through a dialog open-state, not direct RPC fanout.
    expect(src).toMatch(/setBulkRejectOpen\(true\)/);
    // The dialog is rendered for both kinds.
    expect(src).toMatch(/kind="correction"/);
    expect(src).toMatch(/kind="overtime request"/);
    // No more silent OT rejection without a captured reason.
    expect(src).not.toMatch(/Reason\s*\(optional\)/);
  });

  it("MyWeekStrip exists and is mounted on /me/attendance", () => {
    expect(
      existsSync(resolve(ROOT, "src/components/attendance/MyWeekStrip.tsx")),
    ).toBe(true);
    const page = r("src/pages/me/MyAttendance.tsx");
    expect(page).toMatch(/from\s+"@\/components\/attendance\/MyWeekStrip"/);
    expect(page).toMatch(/<MyWeekStrip\b/);
  });

  it("NotificationItem categorizes attendance with its own icon", () => {
    const src = r("src/components/notifications/NotificationItem.tsx");
    expect(src).toMatch(/attendance:\s*Clock/);
    expect(src).toMatch(/from\s+"lucide-react"/);
  });

  it("AttendanceKioskStandalone has activity-reset idle lock", () => {
    const src = r("src/pages/kiosk/AttendanceKioskStandalone.tsx");
    expect(src).toMatch(/idleTimeoutMs/);
    // Activity listeners reset the lock timer.
    expect(src).toMatch(/touchstart/);
    expect(src).toMatch(/keydown/);
    // Lock wipes employee number, not just the PIN.
    expect(src).toMatch(/setEmployeeNumber\(""\)/);
  });
});

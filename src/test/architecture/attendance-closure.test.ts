/**
 * Closure-pass guards for the Attendance overhaul.
 *
 *   1. The dead in-shell kiosk page must be deleted and not lazy-imported.
 *   2. The chrome-less standalone kiosk must remain mounted at /kiosk/attendance.
 *   3. The duplicate Corrections tab must be gone from Attendance.tsx
 *      (single source = /hr/attendance/corrections).
 *   4. PayrollRunList must wire useGenerateAttendanceWorkEntries for draft runs.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../../..");
const r = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("Attendance — closure pass", () => {
  it("legacy in-shell kiosk page is deleted", () => {
    expect(existsSync(resolve(ROOT, "src/pages/hr/AttendanceKiosk.tsx"))).toBe(false);
  });

  it("AttendanceRoutes no longer imports or routes the in-shell kiosk", () => {
    const src = r("src/apps/hr/sub/AttendanceRoutes.tsx");
    expect(src).not.toMatch(/AttendanceKiosk/);
    expect(src).not.toMatch(/path=\s*["']kiosk["']/);
  });

  it("standalone kiosk route is mounted in App.tsx", () => {
    const src = r("src/App.tsx");
    expect(src).toMatch(/\/kiosk\/attendance/);
    expect(src).toMatch(/AttendanceKioskStandalone/);
  });

  it("Attendance.tsx links to the unified Approvals hub, not the legacy queues", () => {
    const src = r("src/pages/hr/Attendance.tsx");
    expect(src).not.toMatch(/TabsTrigger value=\s*["']corrections["']/);
    expect(src).toMatch(/\/hr\/attendance\/approvals/);
  });

  it("PayrollRunList wires the attendance work-entry generator", () => {
    const src = r("src/components/payroll/PayrollRunList.tsx");
    expect(src).toMatch(/useGenerateAttendanceWorkEntries/);
    expect(src).toMatch(/generate\.mutate\(run\.id\)/);
  });
});

/**
 * Architecture guard: the legacy /hr/attendance/corrections and
 * /hr/attendance/overtime routes must redirect into the unified
 * /hr/attendance/approvals hub (preserving ?tab=). Email links and
 * sub-nav badges from earlier versions depend on this.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const routes = readFileSync(
  resolve(__dirname, "../../apps/hr/sub/AttendanceRoutes.tsx"),
  "utf8",
);

describe("Attendance approvals redirects", () => {
  it("imports the new AttendanceApprovals page", () => {
    expect(routes).toMatch(/AttendanceApprovals\s*=\s*lazy/);
  });

  it("exposes /approvals as a permission-gated route", () => {
    expect(routes).toMatch(/path="approvals"/);
  });

  it("keeps the legacy /corrections and /overtime URLs as redirects", () => {
    expect(routes).toMatch(/path="corrections"[\s\S]*RedirectToApprovals tab="corrections"/);
    expect(routes).toMatch(/path="overtime"[\s\S]*RedirectToApprovals tab="overtime"/);
  });

  it("redirect helper preserves the ?row= query param when present", () => {
    expect(routes).toMatch(/new URLSearchParams\(search\)/);
    expect(routes).toMatch(/params\.set\("tab", tab\)/);
  });

  it("no longer imports the obsolete per-queue page components", () => {
    expect(routes).not.toMatch(/lazy\(\(\) => import\("@\/pages\/hr\/AttendanceCorrections"\)\)/);
    expect(routes).not.toMatch(/lazy\(\(\) => import\("@\/pages\/hr\/AttendanceOvertimeRequests"\)\)/);
  });
});

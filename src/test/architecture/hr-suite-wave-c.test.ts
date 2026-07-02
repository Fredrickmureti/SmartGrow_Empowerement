/**
 * hr-suite-wave-c.test.ts — static guards for the latest HR UX continuation
 * (Roster polish + Runs deep-link + EmployeeProfile inline trend +
 * LeaveApprovals sticky bulk bar + the cross-app primitives shipped in
 * the prior turn). Keeps these surfaces from silently regressing.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../../..");
const r = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("HR suite wave-C continuation", () => {
  it("Time-off admin pages exist and are mounted as real routes", () => {
    expect(existsSync(resolve(ROOT, "src/pages/leave/LeaveHolidays.tsx"))).toBe(true);
    expect(existsSync(resolve(ROOT, "src/pages/leave/LeaveTypes.tsx"))).toBe(true);
    const routes = r("src/apps/hr/sub/TimeOffRoutes.tsx");
    expect(routes).toMatch(/path="holidays"/);
    expect(routes).toMatch(/path="types"/);
    expect(routes).toMatch(/LeaveHolidays/);
    expect(routes).toMatch(/LeaveTypes/);
  });

  it("LeaveSubNav Setup dropdown links to the new admin routes", () => {
    const src = r("src/components/leave/LeaveSubNav.tsx");
    expect(src).toMatch(/\/hr\/leave\/holidays/);
    expect(src).toMatch(/\/hr\/leave\/types/);
  });

  it("LegacyTabRedirect forwards ?tab=holidays and ?tab=types", () => {
    const src = r("src/apps/hr/sub/TimeOffRoutes.tsx");
    expect(src).toMatch(/tab === "holidays"/);
    expect(src).toMatch(/tab === "types"/);
  });

  it("MeSubNav exists and MePortalLayout mounts it", () => {
    expect(existsSync(resolve(ROOT, "src/components/me/MeSubNav.tsx"))).toBe(true);
    const layout = r("src/components/me/MePortalLayout.tsx");
    expect(layout).toMatch(/from\s+"@\/components\/me\/MeSubNav"/);
    expect(layout).toMatch(/<MeSubNav/);
  });

  it("Employees inbox hook + ModuleInboxCard 'employees' variant + 4-card strip", () => {
    expect(existsSync(resolve(ROOT, "src/hooks/hr/useEmployeesInboxCounts.ts"))).toBe(true);
    const card = r("src/components/hr/ModuleInboxCard.tsx");
    expect(card).toMatch(/useEmployeesInboxCounts/);
    expect(card).toMatch(/module="employees"/);
    expect(card).toMatch(/export function ModuleInboxStrip/);
  });

  it("ManagerTriageBanner leave reviewPath is the real route, not a ?tab= link", () => {
    const src = r("src/components/hr/ManagerTriageBanner.tsx");
    expect(src).toMatch(/reviewPath:\s*"\/hr\/leave\/approvals"/);
    expect(src).not.toMatch(/\/hr\/leave\?tab=approvals/);
  });

  it("LeaveApprovals + TimesheetApprovals wire useListHotkeys + ManagerTriageBanner", () => {
    const lv = r("src/pages/leave/LeaveApprovals.tsx");
    const ts = r("src/pages/timesheets/TimesheetApprovals.tsx");
    for (const src of [lv, ts]) {
      expect(src).toMatch(/useListHotkeys/);
      expect(src).toMatch(/ManagerTriageBanner/);
    }
  });

  it("LeaveApprovals renders a sticky bulk-action bar driven by selection", () => {
    const src = r("src/pages/leave/LeaveApprovals.tsx");
    expect(src).toMatch(/selectedIds/);
    expect(src).toMatch(/bulkApprove/);
    expect(src).toMatch(/bulkReject/);
    expect(src).toMatch(/Approve all/);
    expect(src).toMatch(/Reject all/);
  });

  it("LeaveApprovalList accepts selection props and renders checkboxes", () => {
    const src = r("src/components/leave/LeaveApprovalList.tsx");
    expect(src).toMatch(/selectedIds\?\s*:\s*Set<string>/);
    expect(src).toMatch(/onToggleSelect\?\s*:/);
    expect(src).toMatch(/<Checkbox/);
  });

  it("Roster page wires SavedViewMenu + StatusFilterChips + run_id chip", () => {
    const src = r("src/pages/hr/Roster.tsx");
    expect(src).toMatch(/SavedViewMenu/);
    expect(src).toMatch(/StatusFilterChips/);
    // run_id chip reads + clears via search params.
    expect(src).toMatch(/searchParams\.get\("run_id"\)|"run_id"/);
    expect(src).toMatch(/clearRunId/);
  });

  it("Shared SavedViewMenu + StatusFilterChips primitives exist", () => {
    expect(existsSync(resolve(ROOT, "src/components/hr/SavedViewMenu.tsx"))).toBe(true);
    expect(existsSync(resolve(ROOT, "src/components/hr/StatusFilterChips.tsx"))).toBe(true);
  });

  it("PayrollRunList has the 'work entries' deep link with run_id", () => {
    const src = r("src/components/payroll/PayrollRunList.tsx");
    expect(src).toMatch(/\/timesheets\/work-entries\?run_id=\$\{run\.id\}/);
  });

  it("EmployeeTrendDrawer supports inline mode; OverviewSection embeds it", () => {
    const drawer = r("src/components/attendance/EmployeeTrendDrawer.tsx");
    expect(drawer).toMatch(/mode\?\s*:\s*"drawer"\s*\|\s*"inline"/);
    expect(drawer).toMatch(/isInline/);

    const overview = r("src/components/employees/profile/OverviewSection.tsx");
    expect(overview).toMatch(/EmployeeTrendDrawer/);
    expect(overview).toMatch(/mode="inline"/);
  });
});

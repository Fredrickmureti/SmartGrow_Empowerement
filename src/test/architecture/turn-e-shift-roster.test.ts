/**
 * Turn E — Architecture guard: roster/shift admin must not be reachable
 * without HR write permission, and self-service roster must not bypass
 * the employee_id self-scope.
 *
 * This is a lightweight static guard: it asserts the existence of the
 * core roster hook surface and that the admin shift page is registered
 * behind a permission gate in the attendance app routes. A genuinely
 * "shipped" Turn E means: hook + admin page + self-service page + route
 * registrations. Removing any of them flips this test red.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const repo = process.cwd();
function read(p: string) {
  return readFileSync(join(repo, p), "utf8");
}

describe("Turn E — Shift & Roster Management wired end-to-end", () => {
  it("ships the useShifts hook with all three CRUD surfaces", () => {
    expect(existsSync(join(repo, "src/hooks/useShifts.ts"))).toBe(true);
    const src = read("src/hooks/useShifts.ts");
    expect(src).toMatch(/export function useShifts\(/);
    expect(src).toMatch(/export function useShiftAssignments\(/);
    expect(src).toMatch(/export function useShiftSwaps\(/);
  });

  it("ships the admin Shifts + Roster pages and the MyShifts self-service page", () => {
    expect(existsSync(join(repo, "src/pages/hr/Shifts.tsx"))).toBe(true);
    expect(existsSync(join(repo, "src/pages/hr/Roster.tsx"))).toBe(true);
    expect(existsSync(join(repo, "src/pages/me/MyShifts.tsx"))).toBe(true);
  });

  it("registers /hr/attendance/shifts and /hr/attendance/roster behind PermissionProtectedRoute", () => {
    const src = read("src/apps/hr/sub/AttendanceRoutes.tsx");
    expect(src).toMatch(/path="shifts"/);
    expect(src).toMatch(/path="roster"/);
    // Both new routes must be inside a PermissionProtectedRoute block.
    const shiftsBlock = src.split('path="shifts"')[1]?.slice(0, 500) ?? "";
    const rosterBlock = src.split('path="roster"')[1]?.slice(0, 500) ?? "";
    expect(shiftsBlock).toMatch(/PermissionProtectedRoute/);
    expect(rosterBlock).toMatch(/PermissionProtectedRoute/);
  });

  it("registers /me/shifts in MeApp routes", () => {
    const src = read("src/apps/me/MeApp.tsx");
    expect(src).toMatch(/path="shifts"/);
    expect(src).toMatch(/MyShifts/);
  });

  it("self-service useShiftSwaps scopes by employee_id (employees can only see swaps they are party to)", () => {
    const src = read("src/hooks/useShifts.ts");
    // The hook accepts an employeeId and filters with .or(requester=…,target=…).
    expect(src).toMatch(
      /requester_employee_id\.eq\.\$\{employeeId\},target_employee_id\.eq\.\$\{employeeId\}/,
    );
  });

  it("edgeFunctionError hint map covers the new roster + immutability + SoD hints", () => {
    const src = read("src/lib/edgeFunctionError.ts");
    for (const k of [
      "ROSTER_ASSIGNMENT_OVERLAP",
      "ROSTER_SWAP_APPROVER_CONFLICT",
      "PAYROLL_RUN_IMMUTABLE",
      "PAYSLIP_IMMUTABLE",
      "PAYSLIP_LINE_IMMUTABLE",
      "PAYROLL_POST_SOD_VIOLATION",
      "PAYROLL_PAY_SOD_VIOLATION",
      "PAYROLL_MAKER_CHECKER_VIOLATION",
      "EXIT_CLEARANCE_UNSETTLED_LOANS",
    ]) {
      expect(src.includes(k), `missing hint copy for ${k}`).toBe(true);
    }
  });
});

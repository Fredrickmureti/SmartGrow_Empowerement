/**
 * Pins the Odoo-style full-page Add Employee architecture.
 *
 * Three invariants:
 *  1. The route `/hr/employees/new` is registered and lazy-loads
 *     `EmployeeNewPage` (URL-addressable, no modal jail).
 *  2. The directory's primary "Add Employee" button navigates to
 *     `/hr/employees/new` (not the modal). The modal is still reachable as
 *     "Quick add" via the split-button dropdown — verified by presence.
 *  3. `EmployeeFormDialog` exposes a `renderAs="page"` mode and the
 *     `useUnsavedChangesGuard` hook exists for router-level dirty blocking.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("Employee full-page route", () => {
  it("registers /hr/employees/new with the EmployeeNewPage component", () => {
    const routes = read("src/apps/hr/sub/EmployeesRoutes.tsx");
    expect(routes).toMatch(/path="employees\/new"/);
    expect(routes).toMatch(/EmployeeNewPage/);
  });

  it("directory primary button navigates to the full-page form", () => {
    const dir = read("src/pages/Employees.tsx");
    expect(dir).toMatch(/navigate\(["']\/hr\/employees\/new["']\)/);
    // Quick-add fallback (legacy modal) still wired in the dropdown.
    expect(dir).toMatch(/Quick add/);
  });

  it("EmployeeFormDialog supports a page-render mode", () => {
    const src = read("src/components/employees/EmployeeFormDialog.tsx");
    expect(src).toMatch(/renderAs\?:\s*"dialog"\s*\|\s*"page"/);
    expect(src).toMatch(/onDirtyChange/);
  });

  it("exposes a router-level unsaved-changes guard hook", () => {
    const hook = read("src/hooks/useUnsavedChangesGuard.ts");
    expect(hook).toMatch(/useBlocker/);
    expect(hook).toMatch(/beforeunload/);
  });
});
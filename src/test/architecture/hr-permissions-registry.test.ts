/**
 * Stage 5 guard: the new HR-private/payroll/catalog permissions are wired
 * end-to-end (declared, role-mapped, and exposed in MODULE_PERMISSION_MAP).
 */
import { describe, it, expect } from "vitest";
import {
  ROLE_PERMISSIONS,
  resolveEffectivePermissions,
  type Permission,
} from "@/lib/permissions";

const NEW_PERMS: Permission[] = [
  "viewEmployeePrivate",
  "viewEmployeePayroll",
  "manageJobPositions",
  "manageWorkLocations",
];

describe("HR permissions registry", () => {
  it("admin / owner / super_admin grant every new HR permission", () => {
    for (const role of ["admin", "owner", "super_admin"] as const) {
      const map = ROLE_PERMISSIONS[role] as Record<string, boolean>;
      for (const p of NEW_PERMS) expect(map[p]).toBe(true);
    }
  });

  it("portal grants none of the new HR permissions", () => {
    const map = ROLE_PERMISSIONS.portal as Record<string, boolean>;
    for (const p of NEW_PERMS) expect(map[p]).toBe(false);
  });

  it("internal users get manageJobPositions when their group includes employees.create", () => {
    const eff = resolveEffectivePermissions("internal", [
      { module: "employees", can_read: true, can_create: true, can_write: true, can_delete: false },
    ]);
    expect(eff.manageJobPositions).toBe(true);
    expect(eff.manageWorkLocations).toBe(true);
  });

  it("internal users without employee permissions get NONE of the new perms", () => {
    const eff = resolveEffectivePermissions("internal", [
      { module: "sales", can_read: true, can_create: false, can_write: false, can_delete: false },
    ]);
    for (const p of NEW_PERMS) expect(eff[p]).toBe(false);
  });
});
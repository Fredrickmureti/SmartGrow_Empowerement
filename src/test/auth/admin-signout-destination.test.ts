/**
 * Unit test: resolveSignOutDestination routes operators to the right login.
 * This locks in the persona-aware sign-out behaviour so a future refactor
 * can't silently dump platform admins back onto the tenant /login screen
 * (the bug we just fixed).
 */
import { describe, it, expect } from "vitest";
import { resolveSignOutDestination } from "@/lib/auth/signOutAndRedirect";

describe("resolveSignOutDestination", () => {
  it("sends platform admins to /admin-management/login", () => {
    expect(resolveSignOutDestination("/admin-management")).toBe("/admin-management/login");
    expect(resolveSignOutDestination("/admin-management/team")).toBe("/admin-management/login");
    expect(resolveSignOutDestination("/admin-management/profile?tab=security")).toBe("/admin-management/login");
  });

  it("sends vendor portal users back to the vendor portal", () => {
    expect(resolveSignOutDestination("/vendor-portal")).toBe("/vendor-portal");
    expect(resolveSignOutDestination("/vendor-portal/orders")).toBe("/vendor-portal");
  });

  it("sends tenant users to the tenant /login by default", () => {
    expect(resolveSignOutDestination("/dashboard")).toBe("/login");
    expect(resolveSignOutDestination("/finance/invoices")).toBe("/login");
    expect(resolveSignOutDestination("/")).toBe("/login");
    expect(resolveSignOutDestination("")).toBe("/login");
  });

  it("is case-insensitive against pathname casing oddities", () => {
    expect(resolveSignOutDestination("/Admin-Management/Team")).toBe("/admin-management/login");
  });
});

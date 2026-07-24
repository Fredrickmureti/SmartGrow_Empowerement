/**
 * Phase 4 architecture pin — the operator workspace shell must exist,
 * its four tabs must be routed as nested children, and legacy
 * /garnishments must redirect so bookmarks keep working.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const repo = process.cwd();
const read = (p: string) => readFileSync(join(repo, p), "utf8");

describe("Legal Orders — Phase 4 operator workspace", () => {
  it("ships the shell and tasks pages", () => {
    expect(existsSync(join(repo, "src/pages/hr/payroll/LegalOrdersWorkspace.tsx"))).toBe(true);
    expect(existsSync(join(repo, "src/pages/hr/payroll/LegalOrdersTasks.tsx"))).toBe(true);
  });

  it("mounts tabs as nested routes under /hr/payroll/legal-orders", () => {
    const routes = read("src/apps/hr/sub/PayrollRoutes.tsx");
    expect(routes).toMatch(/LegalOrdersWorkspace/);
    // Nested Route with index + orders + recipients + remittance-batch
    expect(routes).toMatch(/path="legal-orders"[\s\S]*?Route index[\s\S]*?path="orders"[\s\S]*?path="recipients"[\s\S]*?path="remittance-batch"/);
  });

  it("keeps the legacy /garnishments path via redirect", () => {
    const routes = read("src/apps/hr/sub/PayrollRoutes.tsx");
    expect(routes).toMatch(/path="garnishments"[\s\S]*?Navigate to="\/hr\/payroll\/legal-orders\/orders"/);
  });

  it("shell renders all four tab links", () => {
    const shell = read("src/pages/hr/payroll/LegalOrdersWorkspace.tsx");
    for (const to of [
      "/hr/payroll/legal-orders",
      "/hr/payroll/legal-orders/orders",
      "/hr/payroll/legal-orders/recipients",
      "/hr/payroll/legal-orders/remittance-batch",
    ]) {
      expect(shell).toContain(to);
    }
  });
});

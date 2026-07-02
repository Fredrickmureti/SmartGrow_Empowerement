/**
 * Phase 4 multi-jurisdiction contracts.
 *
 * Static-source assertions that the payroll engine + GL poster have been
 * refactored off the single-country pack lookup and onto the per-employee
 * / per-rule resolver introduced in Phase 4.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const engine = readFileSync(
  resolve(__dirname, "../../../supabase/functions/compute-payroll/index.ts"),
  "utf8",
);
const poster = readFileSync(
  resolve(__dirname, "../../../supabase/functions/post-payroll-gl/index.ts"),
  "utf8",
);

describe("Phase 4 — multi-jurisdiction surface", () => {
  it("compute-payroll resolves country per-employee", () => {
    expect(engine).toMatch(/resolveEmployeeCountry\s*\(/);
    expect(engine).toMatch(/rulesByCountry\s*:/);
    expect(engine).toMatch(/statutory_country_code/);
  });

  it("compute-payroll iterates the employee-scoped rule slice (not the global statutoryRules)", () => {
    // The per-employee loop must use empRules, not the legacy global slice.
    expect(engine).toMatch(/for \(const rule of empRules\)/);
  });

  it("post-payroll-gl resolves country per rule_code, not once per run", () => {
    expect(poster).toMatch(/countryByRule\s*=\s*new Map/);
    expect(poster).toMatch(/countryByRule\.get\(ruleCode\)/);
    // The legacy "look up the org's installed pack country once" comment
    // must be gone or repurposed as a fallback.
    expect(poster).not.toMatch(/Look up the org's installed pack country once/);
  });
});

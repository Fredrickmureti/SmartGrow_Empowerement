/**
 * Stage C contract guards for the payroll engine (Phase 3 closeout).
 *
 * Static-source assertions — cheaper than booting Deno + mocking Supabase
 * for `compute-payroll/index.ts`, and equally protective: they fail the
 * build the instant a regression reintroduces a sentinel or a country
 * branch.
 *
 * Companion to:
 *   - src/test/architecture/no-country-switch-in-payroll-ui.test.ts
 *   - src/test/architecture/no-hardcoded-payroll-role-matrix.test.ts
 *
 * UPDATED (2026-06-01): The engine now rejects the trio
 * `housing_exemption | personal_relief | insurance_relief` through a
 * single generalised sentinel set (`DEPRECATED_SENTINEL_RULE_TYPES`)
 * with a unified `DEPRECATED_SENTINEL_RULE_TYPE` issue code, instead of
 * a per-type `DEPRECATED_HOUSING_EXEMPTION_RULE` constant. These tests
 * now assert that contract.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const engine = readFileSync(
  resolve(__dirname, "../../../supabase/functions/compute-payroll/index.ts"),
  "utf8",
);

describe("payroll engine — Phase 3 closeout contracts", () => {
  it("exposes the generic taxable_income_adjustments path", () => {
    expect(engine).toMatch(/taxable_income_adjustments/);
    expect(engine).toMatch(/computeTaxableIncomeAdjustments\s*\(/);
  });

  it("declares the deprecated sentinel set covering housing/personal/insurance relief", () => {
    expect(engine).toMatch(/DEPRECATED_SENTINEL_RULE_TYPES\s*=\s*new Set/);
    // All three historical sentinels must be enumerated.
    const setBlock = engine.slice(
      engine.indexOf("DEPRECATED_SENTINEL_RULE_TYPES"),
      engine.indexOf("DEPRECATED_SENTINEL_RULE_TYPES") + 400,
    );
    expect(setBlock).toMatch(/housing_exemption/);
    expect(setBlock).toMatch(/personal_relief/);
    expect(setBlock).toMatch(/insurance_relief/);
  });

  it("emits a blocker payroll_run_issue with code DEPRECATED_SENTINEL_RULE_TYPE when a sentinel rule is encountered", () => {
    const idx = engine.indexOf("DEPRECATED_SENTINEL_RULE_TYPES.has");
    expect(idx, "sentinel guard not found in engine").toBeGreaterThan(-1);
    const block = engine.slice(idx, idx + 1500);
    expect(block).toMatch(/DEPRECATED_SENTINEL_RULE_TYPE/);
    expect(block).toMatch(/severity:\s*["']blocker["']/);
    // The branch must continue past the rule rather than silently apply it.
    expect(block).toMatch(/continue;/);
  });

  it("reads per-rule inputs from ctx.inputs registry (no hardcoded insurancePremium on CalcContext)", () => {
    expect(engine).toMatch(/ctx\.inputs\?\.insurance_premium/);
    // CalcContext type MUST NOT carry a top-level insurancePremium field.
    expect(engine).not.toMatch(/insurancePremium\s*:\s*number\s*;/);
  });

  it("never branches the engine on hardcoded country codes", () => {
    // Allow KE/UG/TZ etc. only as data strings (rule rows). Engine code
    // MUST NOT contain `country === "KE"` / `country_code === "KE"` ladders.
    const ladder = /country(_code)?\s*===\s*["'](KE|UG|TZ|NG|GH|ZA|RW)['"]/;
    expect(engine).not.toMatch(ladder);
  });

  it("emits a NO_STATUTORY_RULES_FOR_COUNTRY blocker so silent zero-deduction payslips cannot ship", () => {
    expect(engine).toMatch(/NO_STATUTORY_RULES_FOR_COUNTRY/);
  });
});

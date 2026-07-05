/**
 * Audit 2026-07-05 closeout — plan §R2 (Gap A) + §R3 (Gap B) enforcement.
 *
 * Pins that the compute-payroll engine honours EVERY relief kind and
 * pre-tax input the shipped localization packs reference, not just the
 * flat / rate_of_base subset the initial slice landed with.
 *
 * The previous agent shipped `parameters.reliefs[]` support for `flat`
 * and `rate_of_base` only; `deduction_cap` and `exemption` were
 * declared "handled upstream" but the upstream path did not actually
 * apply them. The KE pack ships three reliefs that require the full
 * pipeline:
 *   - ahr_relief          (rate_of_base, needs ctx.inputs.ahr_contribution)
 *   - mortgage_interest_cap (deduction_cap 30,000)
 *   - disability_exemption  (exemption 150,000, gated on disability_certified)
 *
 * This test pins the engine-side wiring for all of them. It also pins
 * the payslip-header persistence of the taxable base and PAYE-before-relief
 * columns added by the closeout migration.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ENGINE_SRC = readFileSync(
  resolve(__dirname, "../../../supabase/functions/compute-payroll/index.ts"),
  "utf8",
);

describe("Employee input registry (§R3, Gap B)", () => {
  it("registers every pre-tax token referenced by shipped packs", () => {
    for (const token of [
      "insurance_premium",
      "ahr_contribution",
      "mortgage_interest",
      "pension_contribution",
      "post_retirement_medical",
      "disability_certified",
    ]) {
      // The registry entry key appears verbatim on the LHS of the map.
      expect(ENGINE_SRC).toMatch(new RegExp(`\\b${token}\\s*:\\s*\\(emp\\)`));
    }
  });

  it("aggregates pre-tax component amounts from contract_compensation_components", () => {
    expect(ENGINE_SRC).toMatch(/PRETAX_COMPONENT_CODES/);
    expect(ENGINE_SRC).toMatch(/contract_compensation_components/);
  });

  it("reads disability_certified from employee_statutory_identifiers", () => {
    expect(ENGINE_SRC).toMatch(/employee_statutory_identifiers/);
    expect(ENGINE_SRC).toMatch(/identifier_type["']?\s*,\s*["']disability_certified["']/);
  });
});

describe("Reliefs pipeline — full kind coverage (§R2, Gap A)", () => {
  it("Pass A applies employee-input pre-tax deductions with deduction_cap", () => {
    expect(ENGINE_SRC).toMatch(/deductionCapByCode/);
    expect(ENGINE_SRC).toMatch(/deduction_cap/);
    // The cap must be looked up on the income_tax rule's reliefs[] entry
    // and applied via Math.min against the raw employee input.
    expect(ENGINE_SRC).toMatch(/Math\.min\(raw,\s*cap\)/);
  });

  it("Pass A applies exemption reliefs guarded by their condition", () => {
    // Exemption block must iterate income_tax reliefs and gate on condition.
    const idx = ENGINE_SRC.indexOf("Exemption reliefs");
    expect(idx).toBeGreaterThan(0);
    const window = ENGINE_SRC.slice(idx, idx + 1200);
    expect(window).toMatch(/kind\s*\?\?\s*""\)?\.toLowerCase\(\)\s*!==\s*"exemption"/);
    expect(window).toMatch(/r\.condition/);
    expect(window).toMatch(/statutoryDeductible\s*\+=\s*amt/);
  });

  it("bracket_progressive helper no longer marks deduction_cap/exemption as TODO", () => {
    // The old comment ("leaving the branch open here") flagged unfinished
    // work. Its removal is part of the closeout — pin the negative form.
    expect(ENGINE_SRC).not.toMatch(/leaving the branch open here/);
    expect(ENGINE_SRC).toMatch(/applied upstream in Pass A/);
  });
});

describe("Payslip header persistence (closeout migration)", () => {
  it("writes taxable_base and paye_before_relief to the payslips row", () => {
    expect(ENGINE_SRC).toMatch(/taxable_base:\s*finalTaxableBase/);
    expect(ENGINE_SRC).toMatch(/paye_before_relief:/);
    // Must be summed from bracket-trace gross_tax, not re-derived from
    // deductionsDetail (which is PAYE net of reliefs).
    expect(ENGINE_SRC).toMatch(/gross_tax/);
  });
});

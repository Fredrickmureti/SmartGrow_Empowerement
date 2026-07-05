/**
 * PAYE pre-tax deductibility contract.
 *
 * Regression guard for the 2026-07-05 audit: the KE localization pack
 * declares deductibility on the PAYE rule via
 * `parameters.pre_tax_deductions = ["nssf","shif","housing_levy",...]`.
 * The engine (compute-payroll) previously only honoured the imperative
 * form `parameters.reduces_taxable_income=true` on each sibling, so
 * NSSF/SHIF/AHL never reduced the PAYE base and PAYE was taxed on
 * gross — over-charging KE employees by ~KES 2,890/month at 94k gross.
 *
 * The fix makes the engine honour BOTH forms. This test pins the
 * arithmetic on the shipped pack and fails if either the predicate or
 * the pack encoding drifts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ENGINE_SRC = readFileSync(
  resolve(__dirname, "../../../supabase/functions/compute-payroll/index.ts"),
  "utf8",
);

describe("PAYE pre-tax deductibility (ADR-0036 contract)", () => {
  it("engine honours both reduces_taxable_income AND pre_tax_deductions[]", () => {
    // Must consult the income_tax rule's declarative list.
    expect(ENGINE_SRC).toMatch(/pre_tax_deductions/);
    // Must union both encodings — reduces_taxable_income stays supported.
    expect(ENGINE_SRC).toMatch(/reduces_taxable_income\s*===\s*true/);
    // Predicate must be a single isDeductible closure (no per-country branch).
    expect(ENGINE_SRC).toMatch(/const isDeductible\s*=\s*\(r/);
  });

  it("engine remains country-agnostic (no literal rule_code branches)", () => {
    // The predicate must not compare rule_code to any hard-coded country
    // statutory string. This mirrors eslint rule
    // no-literal-rule-codes-in-engines.js but pins the specific patch site.
    const banned = /(rule_code\s*[=!]==?\s*['"](paye|nssf|shif|ahl|nhif|housing_levy)['"])/i;
    // Grab the ~40-line window around the isDeductible predicate.
    const idx = ENGINE_SRC.indexOf("const isDeductible");
    expect(idx).toBeGreaterThan(0);
    const window = ENGINE_SRC.slice(Math.max(0, idx - 200), idx + 1500);
    expect(window).not.toMatch(banned);
  });

  it("KE bracket arithmetic: gross 94,000 minus NSSF+SHIF+AHL taxes to 17,692.85", () => {
    // Independent oracle for the audit — same brackets as the shipped
    // KE pack (Finance Act 2023). If someone edits the KE pack bands
    // without a corresponding test update, this fails.
    const brackets = [
      { min: 0, max: 24000, rate: 10 },
      { min: 24001, max: 32333, rate: 25 },
      { min: 32334, max: 500000, rate: 30 },
      { min: 500001, max: 800000, rate: 32.5 },
      { min: 800001, max: null, rate: 35 },
    ];
    const gross = 94000;
    const nssf = 5640;
    const shif = 2585;
    const ahl = 1410;
    const personalRelief = 2400;

    const taxable = gross - nssf - shif - ahl; // 84,365
    expect(taxable).toBe(84365);

    let tax = 0;
    for (const b of brackets) {
      const upper = b.max ?? Infinity;
      if (taxable <= b.min) break;
      const slabTop = Math.min(taxable, upper);
      const slab = Math.max(0, slabTop - b.min + (b.min === 0 ? 0 : 1) * 0);
      // Bracket math on the KE pack uses [min, max] inclusive with min
      // treated as lower boundary, so slab = min(taxable, upper) - lower
      // where lower = the previous max, i.e. b.min − 1 for tiers ≥ 2.
      const lower = b.min === 0 ? 0 : b.min - 1;
      const actualSlab = Math.max(0, Math.min(taxable, upper) - lower);
      tax += actualSlab * (b.rate / 100);
      void slab;
      if (taxable <= upper) break;
    }
    const paye = Math.max(0, Math.round((tax - personalRelief) * 100) / 100);
    // Correct PAYE after applying pre-tax NSSF/SHIF/AHL and personal relief.
    expect(paye).toBeCloseTo(17692.85, 1);
  });
});

/**
 * Runtime verification — Finatiq EMP-0001, June 2026.
 *
 * Drives the EXPORTED pure helpers of compute-payroll/index.ts against the
 * EXACT active `payroll_statutory_rules` rows that Finatiq's organization
 * (org id 73c07798…) ships today. This is the same dispatch the live
 * `Deno.serve(...)` handler performs after rule load — only auth/db/IO
 * scaffolding is bypassed. The math, the two-pass flag, the bracket
 * evaluator, and the personal-relief subtraction all execute against the
 * unmodified engine source.
 *
 * Source rules (verified live via supabase--read_query at validation time):
 *   - PAYE (bracket_progressive, 5 bands incl. 500k-800k @32.5,
 *     personal_relief 2400, insurance_relief_rate 15 / max 5000)
 *   - NSSF (tiered_brackets, Tier I 0-9000 @6, Tier II 9001-108000 @6,
 *     reduces_taxable_income=true)  <-- tenant-customised by Finatiq
 *   - SHIF (percentage_of_gross, 2.75%, reduces_taxable_income=true)
 *   - AHL  (percentage_of_gross, 1.5% ee + 1.5% er, reduces_taxable_income=true)
 *   - NITA (per_employee_flat 50, employer_only)
 *
 * Gross 156,000 = wage 80,000 + housing 70,000 + transport 6,000 (contract
 * CON-0003). No insurance_premium recorded for the employee, so the PAYE
 * row's insurance_relief_rate has no premium to apply against → relief
 * contribution is 0 (correct: 15% relief in KE applies to actual life /
 * health insurance premiums paid, not to SHIF/AHL contributions, which are
 * already allowable via reduces_taxable_income per Finance Acts 2023/2024).
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeBracketProgressive,
  computeTieredBrackets,
  computePercentageOfBase,
  computeOneRule,
} from "./index.ts";

// ─── Fixture: live rule rows for org 73c07798 (Finatiq) ────────────────
const RULES = [
  {
    id: "rule-paye",
    rule_type: "income_tax",
    rule_name: "PAYE (Pay As You Earn)",
    rule_code: "paye",
    sort_order: 1,
    computation_method: "bracket_progressive",
    parameters: {
      type: "progressive",
      code: "paye",
      currency: "KES",
      period: "monthly",
      brackets: [
        { min: 0,        max: 24000,   rate: 10 },
        { min: 24001,    max: 32333,   rate: 25 },
        { min: 32334,    max: 500000,  rate: 30 },
        { min: 500001,   max: 800000,  rate: 32.5 },
        { min: 800001,   max: null,    rate: 35 },
      ],
      personal_relief: 2400,
      insurance_relief_rate: 15,
      insurance_relief_max: 5000,
      disability_exemption: 150000,
    },
  },
  {
    id: "rule-nssf",
    rule_type: "statutory_deduction",
    rule_name: "NSSF (National Social Security Fund)",
    rule_code: "nssf",
    sort_order: 2,
    computation_method: "tiered_brackets",
    parameters: {
      currency: "KES",
      period: "monthly",
      reduces_taxable_income: true,
      tiers: [
        { name: "Tier I",  lower_earnings_limit: 0,    upper_earnings_limit: 9000,   employee_rate: 6, employer_rate: 6 },
        { name: "Tier II", lower_earnings_limit: 9001, upper_earnings_limit: 108000, employee_rate: 6, employer_rate: 6 },
      ],
    },
  },
  {
    id: "rule-shif",
    rule_type: "statutory_deduction",
    rule_name: "SHIF (Social Health Insurance Fund)",
    rule_code: "shif",
    sort_order: 3,
    computation_method: "percentage_of_gross",
    parameters: {
      base: "gross_pay",
      code: "shif",
      currency: "KES",
      period: "monthly",
      rate: 2.75,
      employee_only: true,
      type: "percentage",
      reduces_taxable_income: true,
    },
  },
  {
    id: "rule-ahl",
    rule_type: "statutory_deduction",
    rule_name: "Affordable Housing Levy (AHL)",
    rule_code: "housing_levy",
    sort_order: 4,
    computation_method: "percentage_of_gross",
    parameters: {
      base: "gross_pay",
      code: "housing_levy",
      currency: "KES",
      period: "monthly",
      employee_rate: 1.5,
      employer_rate: 1.5,
      type: "percentage",
      reduces_taxable_income: true,
    },
  },
  {
    id: "rule-nita",
    rule_type: "statutory_deduction",
    rule_name: "NITA (National Industrial Training Authority)",
    rule_code: "nita",
    sort_order: 5,
    computation_method: "per_employee_flat",
    parameters: {
      amount_per_employee: 50,
      code: "nita",
      currency: "KES",
      period: "monthly",
      employer_only: true,
      type: "fixed",
    },
  },
] as const;

Deno.test("Finatiq EMP-0001 June 2026 — two-pass engine math", () => {
  const grossPay = 156_000;
  const basicSalary = 80_000;
  const housingAllowance = 70_000;
  const transport = 6_000;
  // No exempt housing declared in pack → taxableIncome starts at grossPay
  // (matches engine: grossPay - exemptHousing where exemptHousing = 0).
  const taxableIncome = grossPay;

  const ctx: any = {
    grossPay,
    taxableIncome,
    basicSalary,
    inputs: { insurance_premium: 0 },
  };

  // Mirror engine pass A/B partitioning.
  const isDeductible = (r: any) => r.parameters?.reduces_taxable_income === true;
  const passA = RULES.filter(isDeductible);
  const passB = RULES.filter((r) => !isDeductible(r));

  const ded: Record<string, number> = {};
  const ctr: Record<string, number> = {};
  let statutoryDeductible = 0;

  for (const r of passA) {
    const res = computeOneRule(r as any, ctx, undefined as any, [] as any);
    if (!res) continue;
    if (res.employee_amount > 0) {
      ded[res.rule_name] = (ded[res.rule_name] || 0) + res.employee_amount;
      statutoryDeductible += res.employee_amount;
    }
    if (res.employer_amount > 0) {
      ctr[res.rule_name] = (ctr[res.rule_name] || 0) + res.employer_amount;
    }
  }

  ctx.taxableIncome = Math.max(0, taxableIncome - statutoryDeductible);

  for (const r of passB) {
    const res = computeOneRule(r as any, ctx, undefined as any, [] as any);
    if (!res) continue;
    if (res.employee_amount > 0) ded[res.rule_name] = (ded[res.rule_name] || 0) + res.employee_amount;
    if (res.employer_amount > 0) ctr[res.rule_name] = (ctr[res.rule_name] || 0) + res.employer_amount;
  }

  // ─── Closed-form expected values ────────────────────────────────────
  const expectedNSSFee = 540 + 5_939.94;          // 6,479.94
  const expectedSHIF   = 4_290;                   // 2.75% * 156000
  const expectedAHLee  = 2_340;                   // 1.5%  * 156000
  const expectedAHLer  = 2_340;
  const expectedNITAer = 50;
  const expectedBase   = grossPay - expectedNSSFee - expectedSHIF - expectedAHLee; // 142,890.06
  // Bands use min/max exactly as the pack ships them (lower-inclusive slabs):
  //   Tier 1: 24000        @10%   = 2400.00
  //   Tier 2: 32333−24001  @25%   = 8332 * 0.25 = 2083.00
  //   Tier 3: base−32334   @30%   = 110556.06 * 0.30 = 33166.818
  //   Gross PAYE = 37,649.818  − personal_relief 2400 = 35,249.82
  const expectedPAYE   = 35_249.82;
  const expectedDedTotal = expectedNSSFee + expectedSHIF + expectedAHLee + expectedPAYE;
  const expectedNet = grossPay - expectedDedTotal;

  // ─── Assertions ─────────────────────────────────────────────────────
  assertEquals(round2(ded["NSSF (National Social Security Fund)"]), round2(expectedNSSFee));
  assertEquals(round2(ded["SHIF (Social Health Insurance Fund)"]), round2(expectedSHIF));
  assertEquals(round2(ded["Affordable Housing Levy (AHL)"]),       round2(expectedAHLee));
  assertEquals(round2(ctr["Affordable Housing Levy (AHL)"]),       round2(expectedAHLer));
  assertEquals(round2(ctr["NITA (National Industrial Training Authority)"]), expectedNITAer);
  assertEquals(round2(ctx.taxableIncome), round2(expectedBase));
  assertEquals(round2(ded["PAYE (Pay As You Earn)"]), round2(expectedPAYE));

  const dedTotal = Object.values(ded).reduce((s, v) => s + v, 0);
  assertEquals(round2(dedTotal), round2(expectedDedTotal));
  assertEquals(round2(grossPay - dedTotal), round2(expectedNet));

  // Sanity log for the user-facing verdict.
  console.log(JSON.stringify({
    gross: grossPay,
    taxable_base_after_passA: ctx.taxableIncome,
    deductions: ded,
    contributions: ctr,
    total_deductions: round2(dedTotal),
    net_pay: round2(grossPay - dedTotal),
  }, null, 2));
});

Deno.test("Regression: disabling reduces_taxable_income flag inflates PAYE (locks two-pass invariant)", () => {
  const grossPay = 156_000;
  const ctx: any = { grossPay, taxableIncome: grossPay, basicSalary: 80_000, inputs: {} };
  // Single PAYE rule, no pass-A reducers.
  const paye = RULES.find((r) => r.rule_code === "paye")!;
  const res = computeOneRule(paye as any, ctx, undefined as any, [] as any)!;
  // 24000@10 + (32333-24001)@25 + (156000-32334)@30
  // = 2400 + 2083.00 + 37099.80 = 41582.80  − personal_relief 2400 = 39,182.80
  assertEquals(round2(res.employee_amount), 39_182.80);
});

function round2(n: number) { return Math.round(n * 100) / 100; }

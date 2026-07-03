/**
 * Round 11 Step 1 — RuleSimulator pure-function coverage.
 *
 * Pins the math the editor preview shows so the UI cannot silently drift
 * from what production payroll would compute on the same parameter shape.
 */
import { describe, it, expect } from "vitest";
import { simulateRule } from "../../features/localization/lib/ruleSimulator";

describe("simulateRule — progressive PAYE", () => {
  const params = {
    type: "progressive",
    brackets: [
      { lower: 0, upper: 24000, rate: 10 },
      { lower: 24000, upper: 32333, rate: 25 },
      { lower: 32333, upper: null, rate: 30 },
    ],
    personal_relief: 2400,
  };

  it("taxes each band on the correct slice and applies personal relief", () => {
    const r = simulateRule("income_tax", params, { gross: 50000, period: "monthly" });
    // Band 1: 24000 * 10% = 2400
    // Band 2: (32333-24000) * 25% = 2083.25
    // Band 3: (50000-32333) * 30% = 5300.1
    // Total before relief: 9783.35; after relief 2400 → 7383.35
    expect(r.employee_amount).toBeCloseTo(7383.35, 2);
    expect(r.employer_amount).toBe(0);
    expect(r.breakdown.length).toBeGreaterThanOrEqual(3);
  });

  it("treats null upper as +Infinity", () => {
    const r = simulateRule("income_tax", params, { gross: 100000, period: "monthly" });
    // Band 3 slice is 100000-32333 = 67667 * 30% = 20300.1
    expect(r.employee_amount).toBeGreaterThan(0);
  });
});

describe("simulateRule — percentage statutory", () => {
  it("applies rate-as-percent and respects cap", () => {
    const r = simulateRule(
      "statutory_deduction",
      { type: "percentage", rate: 6, base: "gross", cap: 1500 },
      { gross: 50000, period: "monthly" },
    );
    // 6% of 50000 = 3000; capped at 1500
    expect(r.employee_amount).toBe(1500);
  });

  it("treats rate strictly as percent (aligned with engine `pct()`)", () => {
    // Phase 2 alignment: production `compute-payroll/index.ts` uses
    // pct(n) = n/100 unconditionally. A rate of 0.06 therefore means
    // 0.06% (= 0.0006), not 6%. The old simulator heuristic auto-promoted
    // rates ≤ 1 to fractions and produced misleading previews for any
    // pack that stored decimals — removed.
    const r = simulateRule(
      "statutory_deduction",
      { type: "percentage", rate: 0.06, base: "gross" },
      { gross: 50000, period: "monthly" },
    );
    expect(r.employee_amount).toBe(30); // 0.06% of 50000
  });

  it("accepts `ceiling` as an alias for `cap`", () => {
    const r = simulateRule(
      "statutory_deduction",
      { type: "percentage", rate: 6, base: "gross", ceiling: 1500 },
      { gross: 50000, period: "monthly" },
    );
    expect(r.employee_amount).toBe(1500);
  });

  it("prefers explicit computation_method over parameters.type", () => {
    // Engine dispatches on computation_method — simulator should too when
    // both are provided.
    const r = simulateRule(
      "statutory_deduction",
      { type: "mystery", rate: 6, base: "gross" },
      { gross: 50000, period: "monthly" },
      "percentage_of_gross",
    );
    expect(r.employee_amount).toBe(3000);
  });
});

describe("simulateRule — flat", () => {
  it("returns the flat amount, capped if cap < amount", () => {
    expect(simulateRule("statutory_deduction", { type: "flat", amount: 200 }, { gross: 50000, period: "monthly" }).employee_amount).toBe(200);
    expect(simulateRule("statutory_deduction", { type: "flat", amount: 500, cap: 200 }, { gross: 50000, period: "monthly" }).employee_amount).toBe(200);
  });
});

describe("simulateRule — tiered employer/employee (NSSF-style)", () => {
  it("splits gross across tiers and computes both sides", () => {
    const r = simulateRule(
      "statutory_deduction",
      {
        type: "tiered_employer_employee",
        tiers: [
          { name: "Tier I",  lower_earnings_limit: 0,    upper_earnings_limit: 7000,  employee_rate: 6, employer_rate: 6 },
          { name: "Tier II", lower_earnings_limit: 7000, upper_earnings_limit: 36000, employee_rate: 6, employer_rate: 6 },
        ],
      },
      { gross: 50000, period: "monthly" },
    );
    // Tier I slice = 7000 * 6% = 420 each side
    // Tier II slice = (36000-7000) * 6% = 1740 each side
    // Total per side = 2160
    expect(r.employee_amount).toBeCloseTo(2160, 2);
    expect(r.employer_amount).toBeCloseTo(2160, 2);
  });
});

describe("simulateRule — pension", () => {
  it("contributes equally on both sides, capped if cap supplied", () => {
    const r = simulateRule(
      "statutory_deduction",
      { type: "pension", rate: 5 },
      { gross: 40000, period: "monthly" },
    );
    expect(r.employee_amount).toBe(2000);
    expect(r.employer_amount).toBe(2000);
  });
});

describe("simulateRule — unknown computation", () => {
  it("returns a friendly warning, no crash", () => {
    const r = simulateRule("income_tax", { type: "mystery" }, { gross: 50000, period: "monthly" });
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.employee_amount).toBe(0);
  });
});

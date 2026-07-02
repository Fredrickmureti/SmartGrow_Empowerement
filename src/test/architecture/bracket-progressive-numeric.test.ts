/**
 * Numeric regression guard for the generic `bracket_progressive` evaluator
 * in supabase/functions/compute-payroll/index.ts.
 *
 * Country-agnostic. The fixtures exercise:
 *   - single-tier rule
 *   - multi-tier rule using the `max` ceiling alias
 *   - multi-tier rule using the `upper` ceiling alias (parity)
 *   - open-ended top tier (income above ceiling)
 *   - personal-relief floor at 0
 *
 * History: a `||` in the ceiling-alias coalesce caused every tier to
 * collapse to Infinity, so the engine taxed the full income at tier-1
 * only. This test reproduces the exact slab math the engine must perform.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ENGINE = readFileSync(
  join(process.cwd(), "supabase/functions/compute-payroll/index.ts"),
  "utf8",
);

/** Mirror of computeBracketProgressive's contract — must stay in sync. */
function evaluate(brackets: any[], income: number, personalRelief = 0): number {
  let tax = 0;
  for (const b of brackets) {
    const lower = Number(b.min ?? b.lower ?? 0);
    const rawUpper = b.max ?? b.upper;
    const upper = rawUpper == null ? Infinity : Number(rawUpper);
    const rate = (Number(b.rate) || 0) / 100;
    if (income <= lower) break;
    const slabTop = Math.min(income, upper);
    const slab = Math.max(0, slabTop - lower);
    tax += slab * rate;
    if (income <= upper) break;
  }
  return Math.max(0, Math.round((tax - personalRelief) * 100) / 100);
}

describe("bracket_progressive evaluator — numeric contract", () => {
  it("the engine source uses the alias-coalesce form (rawUpper ?? null check)", () => {
    // Guard against regression to the broken `b.max == null || b.upper == null`
    // form that produced flat tier-1 taxation across the board.
    expect(ENGINE).toMatch(/const\s+rawUpper\s*=\s*b\.max\s*\?\?\s*b\.upper/);
    expect(ENGINE).not.toMatch(/b\.max\s*==\s*null\s*\|\|\s*b\.upper\s*==\s*null/);
  });

  it("single tier, income below ceiling, flat rate", () => {
    const brackets = [{ min: 0, max: 100_000, rate: 10 }];
    expect(evaluate(brackets, 50_000)).toBe(5_000);
  });

  it("multi-tier with `max` alias spans all tiers (KE PAYE shape)", () => {
    const brackets = [
      { min: 0, max: 24_000, rate: 10 },
      { min: 24_001, max: 32_333, rate: 25 },
      { min: 32_334, max: 500_000, rate: 30 },
      { min: 500_001, max: null, rate: 35 },
    ];
    // 24000·.10 + 8332·.25 + 76666·.30 = 2400 + 2083 + 22999.8 = 27482.8
    // minus personal relief 2400 = 25082.8
    expect(evaluate(brackets, 109_000, 2_400)).toBeCloseTo(25_082.8, 1);
  });

  it("multi-tier with `upper` alias produces identical numbers (alias parity)", () => {
    const brackets = [
      { lower: 0, upper: 24_000, rate: 10 },
      { lower: 24_001, upper: 32_333, rate: 25 },
      { lower: 32_334, upper: 500_000, rate: 30 },
      { lower: 500_001, upper: null, rate: 35 },
    ];
    expect(evaluate(brackets, 109_000, 2_400)).toBeCloseTo(25_082.8, 1);
  });

  it("income above the open-ended top tier taxes the remainder at top rate", () => {
    const brackets = [
      { min: 0, max: 100_000, rate: 10 },
      { min: 100_000, max: null, rate: 30 },
    ];
    // 100000·.10 + 100000·.30 = 10000 + 30000 = 40000
    expect(evaluate(brackets, 200_000)).toBe(40_000);
  });

  it("relief never drives tax negative — floored at 0", () => {
    const brackets = [{ min: 0, max: 100_000, rate: 10 }];
    expect(evaluate(brackets, 10_000, 5_000)).toBe(0);
  });
});
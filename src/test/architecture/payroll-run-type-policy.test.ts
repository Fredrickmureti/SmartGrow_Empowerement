/**
 * Architecture guard — Phase 3.1: Run-Type Behavior Matrix.
 *
 * Locks the contract that the payroll engine reads run-type behavior from
 * the `payroll_run_type_policies` catalogue (via `payroll_get_run_type_policy`)
 * instead of branching on the `run_type` string. Without this guard a future
 * change could silently reintroduce hardcoded behavior like
 * `if (runType === 'bonus') { ... }` and we'd lose the single source of truth.
 *
 * Companion to:
 *   - supabase migration `payroll_run_type_policies` (table + seed + resolver)
 *   - docs/adr/0043-payroll-run-type-behavior-matrix.md
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const engine = readFileSync(
  resolve(__dirname, "../../../supabase/functions/compute-payroll/index.ts"),
  "utf8",
);

describe("Payroll engine — Run-Type Behavior Matrix (Phase 3.1)", () => {
  it("resolves the run-type policy through the canonical RPC", () => {
    expect(engine).toMatch(/payroll_get_run_type_policy/);
    expect(engine).toMatch(/runTypePolicy\s*[:=]/);
  });

  it("persists the resolved policy onto the payroll_runs row", () => {
    expect(engine).toMatch(/run_type_policy_snapshot:\s*runTypePolicy/);
  });

  it("gates recurring earnings on the policy, not on the run_type string", () => {
    expect(engine).toMatch(/applies_recurring_earnings/);
    // The salary-suppression block must reference the policy flag.
    const suppression = engine.match(
      /if\s*\(!runTypePolicy\.applies_recurring_earnings\)\s*\{[\s\S]{0,500}\}/,
    );
    expect(suppression, "recurring-earnings suppression block missing").toBeTruthy();
  });

  it("gates loans, garnishments and recurring deductions on the policy", () => {
    expect(engine).toMatch(/runTypePolicy\.applies_loan_installments/);
    expect(engine).toMatch(/runTypePolicy\.applies_garnishments/);
    expect(engine).toMatch(/runTypePolicy\.applies_recurring_deductions/);
  });

  it("does NOT branch computation on hardcoded run_type string equality", () => {
    // Allow validation / duplicate-detection branches (regular, correction,
    // supplemental, termination clearance) — those are control-flow gates, not
    // computation. Any NEW computation branch keyed on a literal run_type
    // string must instead become a column on payroll_run_type_policies.
    const computationBranches = engine.match(
      /runType\s*===\s*["'](bonus|commission|13th_month|off_cycle)['"]/g,
    );
    expect(computationBranches, "Found computation branch keyed on literal run_type — extend payroll_run_type_policies instead").toBeNull();
  });

  it("declares every supported run type in the validation allow-list", () => {
    const allowed = engine.match(/ALLOWED_RUN_TYPES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    expect(allowed).toBeTruthy();
    const body = allowed![1];
    for (const rt of [
      "regular","off_cycle","supplemental","bonus",
      "commission","13th_month","termination","correction",
    ]) {
      expect(body).toContain(rt);
    }
  });
});

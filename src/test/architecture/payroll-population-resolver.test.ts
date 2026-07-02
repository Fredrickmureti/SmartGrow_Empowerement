/**
 * Architecture guard — Phase 3.2: Population Resolver.
 *
 * Locks the contract that the payroll engine NEVER trusts the caller-supplied
 * `employee_ids` as the final population. Every run must round-trip the
 * intent through `payroll_resolve_run_population`, which is the single source
 * of truth for "who does this run pay?" — driven by the run-type policy's
 * `population_source` and the cross-cutting eligibility gates.
 *
 * Companion to:
 *   - migration: function `public.payroll_resolve_run_population`
 *   - docs/adr/0044-payroll-run-population-resolver.md
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const engine = readFileSync(
  resolve(__dirname, "../../../supabase/functions/compute-payroll/index.ts"),
  "utf8",
);

describe("Payroll engine — Population Resolver (Phase 3.2)", () => {
  it("calls payroll_resolve_run_population as the population source of truth", () => {
    expect(engine).toMatch(/payroll_resolve_run_population/);
  });

  it("passes run_type, parent_run_id and the caller hint into the resolver", () => {
    const call = engine.match(
      /payroll_resolve_run_population[\s\S]{0,800}p_explicit_employee_ids:\s*employee_ids/,
    );
    expect(call, "resolver call missing the canonical argument shape").toBeTruthy();
  });

  it("rejects caller-supplied employees the resolver excluded (no silent drops)", () => {
    expect(engine).toMatch(/POPULATION_REJECTED/);
    expect(engine).toMatch(/rejected_employee_ids/);
  });

  it("surfaces an empty-population condition with a structured error", () => {
    expect(engine).toMatch(/POPULATION_EMPTY/);
  });

  it("fails closed if the resolver itself errors", () => {
    expect(engine).toMatch(/POPULATION_RESOLVE_FAILED/);
  });
});
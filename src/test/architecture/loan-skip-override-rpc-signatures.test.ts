/**
 * Guards for the Loan Skip Overrides subsystem.
 *
 *  1. `apply_loan_skip_schedule_adjustment` must have exactly ONE overload
 *     and must accept `(_override_id, _payroll_run_id)`. This is the
 *     canonical signature `compute-payroll` calls — a regression would
 *     silently swallow schedule adjustments into LOAN_SKIP_ADJUSTMENT_FAILED.
 *
 *  2. The compute-payroll edge function must call that RPC with the
 *     override-centric argument names; the old `(_loan_id, _schedule_id)`
 *     form must never re-appear.
 *
 *  3. The frontend hook must continue to read/write through the
 *     hardened maker-checker RPCs and the canonical table.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const read = (p: string) => readFileSync(p, "utf8");

describe("Loan Skip Override — code-level guards", () => {
  it("compute-payroll calls apply_loan_skip_schedule_adjustment with the override-centric args", () => {
    const src = read("supabase/functions/compute-payroll/index.ts");
    expect(src).toMatch(/apply_loan_skip_schedule_adjustment/);
    expect(src).toMatch(/_override_id/);
    expect(src).toMatch(/_payroll_run_id/);
    expect(src).not.toMatch(
      /apply_loan_skip_schedule_adjustment[^)]*_loan_id[^)]*_schedule_id/s,
    );
  });

  it("hook delegates approve/reject/cancel to the governance-aware RPCs", () => {
    const src = read("src/hooks/useLoanSkipOverrides.ts");
    expect(src).toMatch(/loan_skip_override_approve/);
    expect(src).toMatch(/loan_skip_override_reject/);
    expect(src).toMatch(/loan_skip_override_cancel/);
    // The hook must never short-circuit the server RPC by mutating status itself.
    expect(src).not.toMatch(/\.update\(\s*\{\s*status:\s*['"]approved['"]/);
    expect(src).not.toMatch(/\.update\(\s*\{\s*status:\s*['"]rejected['"]/);
  });

  it("Governance catalogue registers the three loan-skip action keys", () => {
    const src = read("src/lib/governance/selfActionCatalogue.ts");
    expect(src).toMatch(/payroll\.loan_skip_override\.approve/);
    expect(src).toMatch(/payroll\.loan_skip_override\.reject/);
    expect(src).toMatch(/payroll\.loan_skip_override\.cancel/);
    expect(src).toMatch(/payroll_run_loan_skip_override/);
  });
});

const url = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
  process.env.SUPABASE_PUBLISHABLE_KEY;
const runIf = url && key ? describe : describe.skip;

runIf("apply_loan_skip_schedule_adjustment has a single canonical overload", () => {
  it("called with bogus uuids does NOT raise PGRST203 (ambiguity)", async () => {
    const supabase = createClient(url!, key!);
    const { error } = await supabase.rpc(
      "apply_loan_skip_schedule_adjustment",
      {
        _override_id: "00000000-0000-0000-0000-000000000000",
        _payroll_run_id: "00000000-0000-0000-0000-000000000000",
      } as any,
    );
    if (error) {
      // A "not found" / RLS error is fine; ambiguity is not.
      expect(error.code).not.toBe("PGRST203");
      expect(error.message).not.toMatch(/choose the best candidate function/i);
    }
  });
});
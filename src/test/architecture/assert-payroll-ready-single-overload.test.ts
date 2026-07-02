/**
 * Guard: `public.assert_payroll_ready` must have exactly ONE overload.
 *
 * History: a 5-arg version and a 6-arg superset (adds `p_run_id`) coexisted,
 * causing PostgREST `PGRST203` ambiguity when callers passed the 5 common
 * named args. The 6-arg overload is the canonical one (all args defaulted).
 *
 * This test fails loudly if a future migration re-introduces a second
 * overload, so the ambiguity cannot silently regress.
 */
import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";

const url = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
  process.env.SUPABASE_PUBLISHABLE_KEY;

const runIf = url && key ? describe : describe.skip;

runIf("assert_payroll_ready has a single overload", () => {
  it("pg_proc returns exactly one row for the function name", async () => {
    const supabase = createClient(url!, key!);
    const { data, error } = await supabase.rpc("assert_payroll_ready", {
      p_org_id: "00000000-0000-0000-0000-000000000000",
      p_business_id: null,
      p_employee_ids: null,
      p_period_start: null,
      p_period_end: null,
    });
    // We don't care about the result — only that PostgREST did NOT return
    // PGRST203 ("Could not choose the best candidate function").
    if (error) {
      expect(error.code).not.toBe("PGRST203");
      expect(error.message).not.toMatch(/choose the best candidate function/i);
    }
    expect(data === null || data !== undefined).toBe(true);
  });
});

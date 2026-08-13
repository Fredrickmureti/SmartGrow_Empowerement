import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Phase 5.2/5.3 guard: the payables engine must keep a behavioural fixture.
 *
 * Contract tests prove the SHAPE of the AP aging functions; only the scenario
 * fixture proves the NUMBERS. If it is deleted or hollowed out, a regression in
 * point-in-time behaviour (a payment leaking into a historical re-run, a
 * reversed payment still settling a bill) becomes invisible again.
 */
const FIXTURE = "supabase/tests/ap_aging_as_of_test.sql";

function fixture(): string {
  return readFileSync(resolve(process.cwd(), FIXTURE), "utf8");
}

describe("AP aging as-of scenario fixtures", () => {
  const sql = fixture();

  it("seeds its own isolated organization and rolls back", () => {
    expect(sql).toContain("INSERT INTO public.organizations");
    expect(sql).toContain("rollback: behavioural block complete");
  });

  it("covers every required accounting scenario A–J", () => {
    for (const marker of [
      "===== A:",
      "===== B:",
      "===== C:",
      "===== D:",
      "===== E:",
      "===== F:",
      "===== G:",
      "===== H:",
      "===== I:",
      "===== J:",
    ]) {
      expect(sql).toContain(marker);
    }
  });

  it("proves history is immutable and reversals do not settle", () => {
    // The as-of engine is queried at a second, earlier date.
    expect(sql).toMatch(/finance_ap_open_items_as_of\(v_org, v_biz, NULL, v_as_of - \d+\)/);
    expect(sql).toContain("reversed payment still reduced the payable");
  });

  it("asserts cross-surface equality on one dataset", () => {
    expect(sql).toContain("get_ap_summary(v_org, v_biz, NULL, v_as_of)");
    expect(sql).toContain("get_ap_aging_summary(v_org, v_biz, NULL, v_as_of)");
    expect(sql).toContain("finance_ap_aging_reconciliation(v_org, v_biz, NULL, v_as_of)");
  });

  it("asserts the engine is not anonymously executable", () => {
    expect(sql).toContain("has_function_privilege('anon'");
  });
});

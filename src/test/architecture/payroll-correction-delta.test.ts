import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Architecture guard — Phase 3.4 (Correction Delta).
 *
 * `compute-payroll` MUST emit signed deltas (not full replacement payslips)
 * when run_type='correction' with a parent_run_id. The YTD trigger is
 * additive across all payslip_lines, so a full replacement double-counts.
 */
describe("compute-payroll: correction runs emit signed deltas", () => {
  const enginePath = join(
    process.cwd(),
    "supabase/functions/compute-payroll/index.ts",
  );
  const src = readFileSync(enginePath, "utf8");

  it("loads parent payslips for correction runs", () => {
    // Must read the parent run's payslips before computing the delta.
    const m = src.match(
      /runType === "correction"[\s\S]{0,400}\.from\("payslips"\)[\s\S]{0,200}\.eq\("payroll_run_id", parentRunId\)/,
    );
    expect(m, "expected correction branch to query parent run payslips").toBeTruthy();
  });

  it("links each correction payslip to its parent via retro_of_payslip_id", () => {
    expect(src).toMatch(/row\.retro_of_payslip_id\s*=\s*parent\.id/);
  });

  it("loads parent payslip_lines and computes per-(rule_code,category) deltas", () => {
    expect(src).toMatch(/\.from\("payslip_lines"\)[\s\S]{0,200}\.in\("payslip_id", parentIds\)/);
    expect(src).toMatch(/`\$\{[^`]*rule_code[^`]*\}\|\$\{[^`]*category[^`]*\}`/);
  });

  it("drops zero-delta employees with RUN_NO_CORRECTION_DELTA marker", () => {
    expect(src).toMatch(/RUN_NO_CORRECTION_DELTA|correctionZeroDeltaEmployees/);
  });

  it("does not bypass the delta path by inserting full payslips on correction runs", () => {
    // Smoke check: the insert block must run AFTER the correction transform
    // (verified by source ordering — the transform precedes the insert).
    const transformIdx = src.indexOf("Phase 3.4 — Correction Delta Engine");
    const insertIdx = src.indexOf('.from("payslips")\n      .insert(payslipsToInsert)');
    expect(transformIdx).toBeGreaterThan(0);
    expect(insertIdx).toBeGreaterThan(transformIdx);
  });
});
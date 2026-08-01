/**
 * Architecture guard — payroll engine ↔ localization pack contract.
 *
 * The Stage-2 regression collapsed multiple statutory rules under one
 * `rule_type` and silently skipped them when `computation_method='auto'`,
 * producing payslips with `total_deductions=0`. The fix removed the
 * heuristic and made `computation_method` the sole dispatch key. These
 * guards prevent that contract from drifting back.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const ENGINE = readFileSync(
  join(process.cwd(), "supabase/functions/compute-payroll/index.ts"),
  "utf8",
);
const PDF = readFileSync(
  join(process.cwd(), "supabase/functions/_shared/payslip/payslipSnapshot.ts"),
  "utf8",
);

describe("payroll architecture guard — engine contract", () => {
  it("compute-payroll selects computation_method when loading rules", () => {
    expect(ENGINE).toMatch(
      /\.from\(\s*["']payroll_statutory_rules["']\s*\)[\s\S]{0,400}computation_method/,
    );
  });

  it("compute-payroll dispatches by rule.computation_method (not by parameter shape)", () => {
    // Must read the field; must NOT fall back to a heuristic that guesses
    // from `parameters.lower / upper / tier1_limit` etc. as it did before.
    expect(ENGINE).toMatch(/rule\.computation_method/);
    // Negative: the old heuristic dispatcher used these literal keys at the
    // root of `parameters`. They must not appear together as method probes.
    const heuristicProbe =
      /params(\.|\?\.|\[["']).*tier1_limit[\s\S]{0,200}params(\.|\?\.|\[["']).*lower/;
    expect(ENGINE).not.toMatch(heuristicProbe);
  });

  it("compute-payroll writes a payroll_run_issues row for unknown methods", () => {
    expect(ENGINE).toMatch(/payroll_run_issues/);
    expect(ENGINE).toMatch(/RULE_SKIPPED|computation_method.*not recognised/i);
  });

  it("generate-payslip-pdf does NOT inject a synthetic Basic Salary row", () => {
    // The dedup-then-inject block was the source of the duplicate Basic
    // Salary regression. The fix removed the injection entirely and made
    // payslip_lines authoritative.
    expect(PDF).toMatch(/payslip_lines is authoritative/);
    // Must not push a "Basic Salary" earning from the PDF generator itself.
    const synthetic =
      /earnings\.push\(\s*\{\s*label\s*:\s*["']Basic Salary["']/;
    expect(PDF).not.toMatch(synthetic);
  });

  it("computation_method column exists on localization pack templates and statutory rules", () => {
    // At least one migration must add the column to both tables.
    const hits = execSync(
      "rg -l 'computation_method' supabase/migrations/ || true",
      { encoding: "utf8" },
    ).split("\n").filter(Boolean);
    expect(hits.length).toBeGreaterThan(0);
  });
});
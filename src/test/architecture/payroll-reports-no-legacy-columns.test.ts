/**
 * Architecture guard — payroll report builders may not project columns
 * that were dropped in the country-agnostic rewrite of `payslips`.
 *
 * A stale `render-report` deploy that still selected `payslips.basic_salary`
 * broke the entire Payroll Reports workspace with a Postgres 42703. This
 * test fails loudly the moment any of the removed columns re-appears in a
 * server-side report builder, so the drift cannot silently ship again.
 *
 * Category-specific decomposition (basic, allowances, statutory employee /
 * employer, etc.) MUST be derived from `payslip_lines` — the authoritative
 * provenance written by `compute-payroll`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

// Columns dropped from `payslips` when the platform went country-agnostic.
// Any builder that reads them will 42703 at query time.
const FORBIDDEN_COLUMNS = ["basic_salary", "other_earnings", "taxable_income"];

// Only server report builders + the render-report dispatcher are in scope.
// `returnSourceResolver.ts` documents these tokens in comments and is
// allowed. Client TS and generated types are irrelevant here.
const IN_SCOPE = [
  "supabase/functions/_shared/reports/payrollData.ts",
  "supabase/functions/_shared/reports/renderReport.ts",
  "supabase/functions/_shared/reports/index.ts",
  "supabase/functions/_shared/reports/columnSpecs.ts",
  "supabase/functions/render-report/index.ts",
];

describe("payroll reports — no legacy payslip columns", () => {
  for (const file of IN_SCOPE) {
    it(`${file} does not select dropped payslips columns`, () => {
      const src = readFileSync(file, "utf8");
      for (const col of FORBIDDEN_COLUMNS) {
        // Ignore contents of comment lines — provenance comments in the
        // resolver are the documented use.
        const codeOnly = src
          .split("\n")
          .filter((l) => !/^\s*(\/\/|\*)/.test(l))
          .join("\n");
        expect(
          codeOnly.includes(col),
          `${file} references dropped payslips.${col} in executable code`,
        ).toBe(false);
      }
    });
  }

  it("no other supabase/functions file selects payslips.basic_salary", () => {
    // Broad safety net — catches any new builder that gets added outside
    // the in-scope list above.
    const out = execSync(
      `rg --files-with-matches "basic_salary" supabase/functions -g '!**/*.test.ts' -g '!_shared/returnSourceResolver.ts' || true`,
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    // compute-payroll + generate-payroll-document write basic_salary onto
    // OTHER tables (payslip inputs, payroll document snapshots) — allowed.
    const disallowed = out.filter(
      (p) =>
        !p.endsWith("compute-payroll/index.ts") &&
        !p.endsWith("generate-payroll-document/index.ts"),
    );
    expect(disallowed, `Unexpected basic_salary reads: ${disallowed.join(", ")}`).toEqual([]);
  });
});
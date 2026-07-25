/**
 * Architecture guard — country-agnostic payroll engine
 *
 * Country-specific statutory tokens (paye, nhif, nssf, sha, shif, kra,
 * housing_levy, nita, ahl) may only appear in:
 *   - localization seed/install code (`install-localization-pack`)
 *   - the localization-gated statutory document generator
 *   - localization seed JSON under `localization/seeds/<country>/`
 *   - this guard file itself
 *
 * Any other hit means a regression: country-specific logic has leaked
 * back into the generic payroll engine. The fix is to move it into a
 * localization pack.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

// Allow occurrences inside JS line/block comments by stripping them before
// matching. Tokens may legitimately appear in design-doc comments.
const FORBIDDEN = /\b(paye|nhif|nssf|shif|kra|housing_levy|sha_|nita|ahl)\b/i;

const ALLOWLIST = [
  /^supabase\/functions\/install-localization-pack\//,
  /^supabase\/functions\/generate-localization-statutory-document\//,
  /^localization\/seeds\//,
  /^src\/test\/architecture\/no-hardcoded-country-payroll\.test\.ts$/,
  // Generated Supabase types mirror legacy data still in other tables (e.g., employees)
  /^src\/integrations\/supabase\/types\.ts$/,
  // Mock factories may reference rule_code keys (string values) in deductions_summary;
  // they are data, not engine logic.
  /^src\/test\/factories\/payroll\.factory\.ts$/,
  // Test fixtures inside the engine directory legitimately reference KE rules
  // when exercising the generic engine against real pack data.
  /\.test\.ts$/,
];

describe("payroll architecture guard", () => {
  it("no country-specific statutory tokens in generic payroll engine", () => {
    const candidates = execSync(
      "rg --files-with-matches -i '\\b(paye|nhif|nssf|shif|kra|housing_levy|sha_|nita|ahl)\\b' " +
        "supabase/functions/compute-payroll " +
        "supabase/functions/post-payroll-gl " +
        "supabase/functions/generate-payslip-pdf " +
        "supabase/functions/generate-payroll-document " +
        "supabase/functions/reverse-payroll " +
        "supabase/functions/post-loan-interest-accrual " +
        "supabase/functions/generate-statutory-return " +
        "supabase/functions/_shared/returnTemplateSchema.ts " +
        "supabase/functions/_shared/certificateSections.ts " +
        "supabase/functions/_shared/xmlWriter.ts " +
        "supabase/functions/_shared/reports/payrollData.ts " +
        "src/hooks/usePayroll.ts " +
        "src/hooks/useEmployeeLoans.ts " +
        "src/hooks/useLoanTypes.ts " +
        "src/pages/hr/payroll " +
        "src/lib/payroll " +
        "|| true",
      { encoding: "utf8" }
    )
      .split("\n")
      .filter(Boolean)
      .filter((path) => !ALLOWLIST.some((re) => re.test(path)));

    // Strip JS comments AND string literals before re-matching. Comments
    // allow design-doc references; string literals allow deprecation /
    // rejection error messages to NAME the forbidden tokens without
    // tripping the guard (the engine has to tell pack authors which
    // tokens were removed).
    const fs = require("node:fs") as typeof import("node:fs");
    const out = candidates.filter((p) => {
      try {
        const src = fs.readFileSync(p, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|\s)\/\/[^\n]*/g, "$1")
          // Template literals
          .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, "``")
          // Double-quoted strings
          .replace(/"(?:\\.|[^"\\])*"/g, '""')
          // Single-quoted strings
          .replace(/'(?:\\.|[^'\\])*'/g, "''");
        return FORBIDDEN.test(src);
      } catch { return true; }
    });

    expect(out, `Country-specific tokens leaked into generic payroll engine:\n${out.join("\n")}`).toEqual([]);
  });
});

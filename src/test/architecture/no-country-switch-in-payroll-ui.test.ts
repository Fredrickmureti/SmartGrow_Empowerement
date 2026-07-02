/**
 * Phase 3 architecture guard — no per-country switch in payroll/employee UI.
 *
 * The Phase 3 closeout removed `statutoryLabelsFor(country)` from
 * EmployeePayrollInfo and `STATUTORY_REPORT_MAP` from PayrollRunDetailsDialog.
 * Both are now data-driven (employee_statutory_identifiers /
 * localization_pack_return_templates). This guard fails the build if a
 * parallel country switch sneaks back into the payroll or employees UI.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ROOTS = ["src/components/payroll", "src/components/employees"];

const RED_FLAGS = [
  // switch on a country expression we toUpperCase
  /switch\s*\(\s*\(?\s*[a-zA-Z_]+\s*\|\|\s*["'][A-Z]{0,3}["']\s*\)?\s*\.\s*toUpperCase\s*\(\s*\)\s*\)/,
  // STATUTORY_REPORT_MAP-style hardcoded country/report literal
  /STATUTORY_REPORT_MAP\s*[:=]/,
  // Inline country case branch (e.g. `case "KE":` with a label literal next to it)
  /case\s+["'](?:KE|UG|TZ|RW|NG|ZA|US|GB)["']\s*:\s*\n[\s\S]{0,200}?(?:NSSF|SHIF|NHIF|KRA|TIN|PAYE)/i,
];

describe("Phase 3 — no per-country switch in payroll/employee UI", () => {
  it("payroll/employee components do not re-encode country→label maps", () => {
    const files = execSync(
      `rg --files ${ROOTS.join(" ")} -g '*.tsx' -g '*.ts' || true`,
      { encoding: "utf8" }
    )
      .split("\n")
      .filter(Boolean);

    const offenders: string[] = [];
    for (const f of files) {
      if (f.includes("__tests__") || f.endsWith(".test.ts") || f.endsWith(".test.tsx")) continue;
      const src = readFileSync(f, "utf8");
      if (RED_FLAGS.some((re) => re.test(src))) offenders.push(f);
    }

    expect(
      offenders,
      `Country-switch detected in payroll/employee UI. Source statutory ID labels from \`employee_statutory_identifiers\` ` +
        `via useEmployeeStatutoryIdentifiers, and source statutory return types from \`localization_pack_return_templates\` ` +
        `via useReturnTemplates. Offenders:\n${offenders.join("\n")}`
    ).toEqual([]);
  });
});

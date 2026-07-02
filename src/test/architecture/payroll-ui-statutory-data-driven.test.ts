/**
 * Stage C guard: the payroll UI consumes statutory data through the
 * pack-driven hooks introduced in Phase 3 closeout, never through
 * hardcoded country tables.
 *
 * Companion to no-country-switch-in-payroll-ui.test.ts, which checks
 * the *negative* (no `switch(country)` blocks); this one checks the
 * *positive* (the data-driven hooks are actually wired in).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dialog = readFileSync(
  resolve(__dirname, "../../components/payroll/PayrollRunDetailsDialog.tsx"),
  "utf8",
);
const empInfo = readFileSync(
  resolve(__dirname, "../../components/employees/EmployeePayrollInfo.tsx"),
  "utf8",
);
const editor = readFileSync(
  resolve(__dirname, "../../components/payroll/StatutoryRuleEditor.tsx"),
  "utf8",
);

describe("payroll UI — statutory surfaces are data-driven", () => {
  it("PayrollRunDetailsDialog pulls return templates from the localization pack", () => {
    expect(dialog).toMatch(/useReturnTemplates/);
    expect(dialog).not.toMatch(/STATUTORY_REPORT_MAP/);
  });

  it("EmployeePayrollInfo reads statutory rows from useEmployeeStatutoryIdentifiers with a legacy-badge fallback", () => {
    expect(empInfo).toMatch(/useEmployeeStatutoryIdentifiers/);
    expect(empInfo).toMatch(/Legacy values/);
    expect(empInfo).not.toMatch(/statutoryLabelsFor\s*\(/);
  });

  it("StatutoryRuleEditor falls back to GENERIC, never to a hardcoded KE default", () => {
    expect(editor).toMatch(/GENERIC/);
    // The previous bug: `defaultCountry || "KE"`.
    expect(editor).not.toMatch(/\|\|\s*["']KE["']/);
  });
});

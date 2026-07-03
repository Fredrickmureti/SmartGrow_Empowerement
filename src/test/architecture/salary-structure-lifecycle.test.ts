/**
 * Guard — salary-structure lifecycle mutations MUST go through RPCs.
 *
 * Historical `useSalaryStructures.deleteStructure` did a raw
 * `.from("salary_structures").delete()` which (a) ran with SET NULL
 * cascade on `employee_contracts.salary_structure_id`, silently
 * unlinking live contracts, and (b) had no preflight for historical
 * payslips. The enterprise fix routes rename/archive/restore/delete
 * through SECURITY DEFINER RPCs; this test fails if any raw destructive
 * `.from("salary_structures")` call reappears.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(process.cwd(), "src/hooks/useSalaryStructures.ts"),
  "utf8",
);

describe("useSalaryStructures lifecycle wiring", () => {
  it("exposes all four lifecycle mutations", () => {
    expect(src).toMatch(/\brenameStructure\b/);
    expect(src).toMatch(/\barchiveStructure\b/);
    expect(src).toMatch(/\brestoreStructure\b/);
    expect(src).toMatch(/\bdeleteStructure\b/);
  });

  it("calls the SECURITY DEFINER RPCs, not raw table mutations", () => {
    expect(src).toMatch(/rename_salary_structure/);
    expect(src).toMatch(/archive_salary_structure/);
    expect(src).toMatch(/restore_salary_structure/);
    expect(src).toMatch(/delete_salary_structure/);
  });

  it("never performs a raw destructive write on salary_structures", () => {
    // Strip comments so the header prose ("did a raw .from(\"salary_structures\").delete()")
    // in code we might paste in future doesn't trip the check.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    // Direct destructive Data-API calls: delete/update on the table.
    expect(code).not.toMatch(/\.from\(\s*["']salary_structures["']\s*\)\s*\.delete\s*\(/);
    expect(code).not.toMatch(/\.from\(\s*["']salary_structures["']\s*\)\s*\.update\s*\(/);
  });

  it("exposes the deletion-report preflight query hook", () => {
    expect(src).toMatch(/useSalaryStructureDeletionReport/);
    expect(src).toMatch(/salary_structure_deletion_report/);
  });
});

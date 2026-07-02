/**
 * Architecture guard — every column the compute-payroll edge function
 * writes into `payslips` MUST exist in the generated Supabase types.
 *
 * This catches the Stage-2 over-reach where `taxable_income` was dropped
 * but the engine still inserted it, causing PGRST204 500s on every run.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ENGINE_FIELDS = [
  "employee_id",
  "organization_id",
  "business_id",
  "basic_salary",
  "gross_pay",
  "total_deductions",
  "net_pay",
  "taxable_income",
  "status",
  "deductions_detail",
  "contributions_detail",
  "unpaid_leave_days",
  "leave_deduction",
  "other_earnings",
  "other_deductions",
  "payroll_run_id",
];

describe("payroll architecture guard — payslips shape", () => {
  it("every field compute-payroll writes exists in generated types", () => {
    const types = readFileSync(
      join(process.cwd(), "src/integrations/supabase/types.ts"),
      "utf8",
    );
    // Slice to the payslips Insert block to avoid false positives elsewhere.
    const start = types.indexOf("payslips: {");
    expect(start, "payslips type not found").toBeGreaterThan(-1);
    const insertStart = types.indexOf("Insert: {", start);
    const insertEnd = types.indexOf("}", insertStart);
    const block = types.slice(insertStart, insertEnd);

    const missing = ENGINE_FIELDS.filter(
      (f) => !new RegExp(`\\b${f}[?:]`).test(block),
    );
    expect(missing, `missing payslips columns: ${missing.join(", ")}`).toEqual([]);
  });
});

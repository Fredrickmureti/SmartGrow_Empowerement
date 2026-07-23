/**
 * Architecture guard — `compute-payroll` must derive the payslip header
 * (`gross_pay`, `total_deductions`, `net_pay`) from `lineRows` (i.e. the
 * `payslip_lines` about to be persisted), not from the parallel
 * `deductionsDetail` / `contributionsDetail` in-memory dicts. The dicts
 * survive as *breakdown metadata* only.
 *
 * If a future edit re-introduces `total_deductions: <dict-sum>` in the
 * `payslipsData.push({...})` payload, this test fails — that's exactly
 * the class of bug that let the PAY-0065 legal-order amount live on the
 * header while never appearing as a line.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const FILE = path.resolve(
  __dirname,
  "../../../supabase/functions/compute-payroll/index.ts",
);

describe("payslip header totals derived from payslip_lines", () => {
  const src = readFileSync(FILE, "utf8");

  it("persists gross_pay/total_deductions/net_pay from lineRows-derived values", () => {
    // These three fields must be sourced from the reconciled per-line totals.
    expect(src).toMatch(/gross_pay:\s*roundCent\(linesEmpEarnings\)/);
    expect(src).toMatch(/total_deductions:\s*roundCent\(linesEmpDeductions\)/);
    expect(src).toMatch(/net_pay:\s*roundCent\(/);
  });

  it("throws PAYSLIP_LINES_TOTAL_MISMATCH when lines disagree with the dict", () => {
    expect(src).toContain("PAYSLIP_LINES_TOTAL_MISMATCH");
    // Reconciliation must compare against the classifier-bucketed lineRows.
    expect(src).toMatch(/classifyPayslipLine\(l as any\)\s*===\s*"deduction"/);
    expect(src).toMatch(/classifyPayslipLine\(l as any\)\s*===\s*"employer_contribution"/);
    expect(src).toMatch(/classifyPayslipLine\(l as any\)\s*===\s*"earning"/);
  });

  it("does not persist total_deductions directly from the dict sum", () => {
    // The dict-sum expression is fine to *compute* (it feeds the assertion
    // as `empTotalDeductions`) but must NEVER appear as the value of the
    // `total_deductions:` header field in the payslips insert payload.
    expect(src).not.toMatch(/total_deductions:\s*empTotalDeductions/);
  });
});
/**
 * Architecture guard — loan repayment posting and readiness stay in lock-step.
 *
 * The posting side (`post-payroll-gl`) resolves loan repayment legs
 * exclusively through `payroll_loan_repayment_gl_targets`, which reads
 * `loan_types.gl_receivable_account_id`. If any code path in
 * `post-payroll-gl` starts resolving a `loan_repayment_*_payable` /
 * `loan_repayment_*_employer_expense` mapping key from
 * `default_account_settings`, that reintroduces the same phantom-key drift
 * this test suite exists to prevent.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const POST_GL = readFileSync(
  join(process.cwd(), "supabase", "functions", "post-payroll-gl", "index.ts"),
  "utf8",
);

describe("post-payroll-gl — loan repayment posting parity", () => {
  it("routes loan legs through payroll_loan_repayment_gl_targets", () => {
    expect(POST_GL).toMatch(/payroll_loan_repayment_gl_targets/);
  });

  it("never resolves a loan_repayment_*_payable / _employer_expense key", () => {
    expect(POST_GL).not.toMatch(/loan_repayment_[a-z0-9_]+_payable/i);
    expect(POST_GL).not.toMatch(/loan_repayment_[a-z0-9_]+_employer_expense/i);
  });
});

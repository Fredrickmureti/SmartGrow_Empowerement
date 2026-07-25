/**
 * Architecture guard — ADR 0091 (payroll leg).
 *
 * A payroll-deducted loan instalment settles an ASSET: it must relieve the
 * loan receivable (and recognise interest income), never park in a
 * `<rule_code>_payable` liability. Before this guard existed,
 * `post-payroll-gl` bucketed `loan_repayment` payslip lines with statutory
 * deductions, so the GL loan receivable drifted permanently from
 * `employee_loans.outstanding_balance` after the first payroll deduction.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const MIGRATIONS = join(ROOT, "supabase/migrations");

function read(rel: string) {
  return readFileSync(join(ROOT, rel), "utf8");
}

/** Body of the LAST migration that (re)defines `fn`. */
function latestBody(fn: string): string | null {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const sql = readFileSync(join(MIGRATIONS, files[i]), "utf8");
    const at = sql.indexOf(`FUNCTION public.${fn}(`);
    if (at >= 0) return sql.slice(at);
  }
  return null;
}

describe("Payroll-deducted loan repayments post to the loan accounts", () => {
  const gl = read("supabase/functions/post-payroll-gl/index.ts");

  it("loan_repayment lines are excluded from the payable deduction bucket", () => {
    expect(gl).toMatch(/cat === "loan_repayment"/);
    expect(gl).toMatch(/loanRepaymentTotal/);
  });

  it("posting resolves loan accounts through the loan module helper", () => {
    expect(gl).toContain("payroll_loan_repayment_gl_targets");
    // Principal relief + interest income, never a payable.
    expect(gl).toMatch(/principal recovery/);
    expect(gl).toMatch(/interest income/);
  });

  it("the helper splits principal/interest on the same basis as manual repayments", () => {
    const body = latestBody("payroll_loan_repayment_gl_targets");
    expect(body, "payroll_loan_repayment_gl_targets migration not found").toBeTruthy();
    expect(body!).toContain("_loan_split_repayment");
    expect(body!).toContain("gl_receivable_account_id");
    expect(body!).toContain("interest_income_account_id");
    // Reversal rows must not be double-counted.
    expect(body!).toContain("reversal_of_id IS NULL");
  });

  it("loan repayment lines no longer demand a <rule_code>_payable mapping", () => {
    const resolver = latestBody("payroll_required_gl_mappings_for_run");
    expect(resolver, "resolver migration not found").toBeTruthy();
    const cte = resolver!.split("needed AS")[0];
    expect(cte).toMatch(/NOT IN \('earning','loan_repayment'\)/);
  });
});

/**
 * Architecture guard — payroll readiness must NEVER demand a
 * `loan_repayment_*_payable` mapping key.
 *
 * Root cause pinned by this test: loan repayments are posted through
 * `payroll_loan_repayment_gl_targets`, which resolves the credit leg from
 * `loan_types.gl_receivable_account_id` (fallback via `_loan_resolve_account`
 * with role `loan_receivable`). It does not read `default_account_settings`
 * for any `loan_repayment_*_payable` key.
 *
 * A prior version of `payroll_required_gl_mappings_for_run` aggregated
 * payslip lines by `rule_code` and — because compute-payroll writes loan
 * lines with `category='deduction'` — leaked a phantom
 * `<loan_rule>_payable` requirement that no code could ever satisfy. Users
 * were trapped between "GL mapping missing" and "everything configured".
 *
 * This guard fails if the latest migration for that function does not
 * exclude loan_repayment lines from the `_payable` / `_employer_expense`
 * aggregation on at least the two independent predicates below.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(process.cwd(), "supabase", "migrations");

function latestMigrationBodyDefining(fnName: string): string {
  const files = readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const marker = new RegExp(
    `FUNCTION\\s+public\\.${fnName}\\s*\\(`, "i",
  );
  for (let i = files.length - 1; i >= 0; i--) {
    const p = join(MIG_DIR, files[i]);
    if (!statSync(p).isFile()) continue;
    const body = readFileSync(p, "utf8");
    if (marker.test(body)) return body;
  }
  throw new Error(`no migration defines ${fnName}`);
}

describe("payroll_required_gl_mappings_for_run — loan repayment exclusion", () => {
  const sql = latestMigrationBodyDefining("payroll_required_gl_mappings_for_run");

  it("excludes payslip lines whose rule_code is loan_repayment*", () => {
    // rule_code prefix is the load-bearing predicate — category alone is
    // unreliable because compute-payroll writes these as 'deduction'.
    expect(sql).toMatch(/lower\(pl\.rule_code\)\s+NOT\s+LIKE\s+'loan_repayment%'/i);
  });

  it("also excludes lines flagged as loan_repayment via source hints", () => {
    // Belt-and-braces: a future refactor changing the rule_code shape must
    // still not reintroduce the phantom.
    expect(sql).toMatch(/source->>'kind'[^\n]*loan_repayment/);
    expect(sql).toMatch(/source->'input_ref'->>'code'[^\n]*loan_repayment/);
  });

  it("emits loan-type-scoped requirements instead of the phantom _payable key", () => {
    // The positive counterpart — loan types get their own readiness rows so
    // an unmapped receivable is still blocked, but with a real remediation
    // path (Loan Types settings).
    expect(sql).toMatch(/loan_type:[^']*receivable/);
    expect(sql).toMatch(/loan_receivable/);
  });
});

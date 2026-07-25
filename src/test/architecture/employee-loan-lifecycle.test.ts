/**
 * Architecture guard — Employee Loan lifecycle (Phase L-J).
 *
 * Ensures the UI never bypasses the server-enforced lifecycle by writing
 * directly to `employee_loans` for sensitive transitions, and that the
 * hook exposes every lifecycle RPC + the LoanDetailDrawer surfaces the
 * action buttons that drive them.
 *
 * If a developer regresses by adding `.from("employee_loans").update(...)`
 * for a status change (which would bypass `guard_employee_loan_self_approval`
 * and the lifecycle event ledger), this test fails.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("Employee Loan lifecycle wiring", () => {
  it("useEmployeeLoans routes lifecycle transitions through RPCs (no direct status writes)", () => {
    const src = read("src/hooks/useEmployeeLoans.ts");
    // Each lifecycle action must call its RPC.
    for (const rpc of [
      "employee_loan_lifecycle_approve",
      "employee_loan_lifecycle_reject",
      "employee_loan_authorize_disbursement",
      "employee_loan_suspend",
      "employee_loan_cancel",
      "employee_loan_pause",
      "employee_loan_resume",

      "employee_loan_write_off",
      "employee_loan_restructure",
      "employee_loan_record_manual_repayment",
    ]) {
      expect(src.includes(rpc), `useEmployeeLoans must invoke RPC ${rpc}`).toBe(true);
    }
    // No raw status updates for write-off / approve / cancel etc.
    expect(/\.from\(\s*["']employee_loans["']\s*\)\s*\.update\(\s*\{[^}]*status\s*:/s.test(src))
      .toBe(false);
  });

  it("LoanDetailDrawer surfaces every lifecycle action", () => {
    const src = read("src/components/loans/LoanDetailDrawer.tsx");
    for (const fn of [
      "approveLoan",
      "authorizeDisbursement",
      "disburseLoan",
      "pauseLoan",
      "resumeLoan",
      "settleLoan",
      "writeOffLoan",
      "restructureLoan",
      "recordManualRepayment",
      "suspendLoan",
      "cancelLoan",
    ]) {
      expect(src.includes(fn), `LoanDetailDrawer must wire ${fn}`).toBe(true);
    }
  });

  it("Self-Action Catalogue registers loan lifecycle keys", () => {
    const src = read("src/lib/governance/selfActionCatalogue.ts");
    for (const key of [
      "employee_loan.authorize_disbursement",
      "employee_loan.write_off",
      "employee_loan.restructure",
      "employee_loan.refinance",
      "employee_loan.record_manual_repayment",
    ]) {
      expect(src.includes(key), `catalogue must list ${key}`).toBe(true);
    }
  });
});

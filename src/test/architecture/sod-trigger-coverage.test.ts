/**
 * Architecture guard — every governed action must have a database guard.
 *
 * `governance_action_registry` is declarative: registering `loan.disburse`
 * does nothing on its own. Enforcement lives in `sod_<table>_guard`
 * BEFORE UPDATE triggers calling `governance_assert_not_self`. Wave G-5 found
 * the lending actions registered but unguarded; Wave G-6 added the triggers.
 *
 * Both lists below are snapshots of the live database (verified 2026-09-07).
 * When a migration adds a governed action or a guard, update them in the same
 * change.
 */
import { describe, it, expect } from "vitest";

/** action_key → subject_table, from governance_action_registry. */
const REGISTERED: Record<string, string> = {
  "bank_account.sensitive_change": "bank_accounts",
  "journal.post": "journal_entries",
  "payment.approve": "payments",
  "loan.approve": "mf_loan_applications",
  "loan.disburse": "mf_loans",
  "loan.restructure": "mf_loans",
  "loan.write_off": "mf_loans",
  "repayment.reverse": "mf_repayments",
  "reversal.loan_repayment": "mf_repayments",
  "app_access.grant": "member_permission_groups",
  "expense.approve": "expenses",
  "expense.approve_self_benefit": "expenses",
  "expense.submit": "expenses",
  "expense.void": "expenses",
  "reversal.expense": "expenses",
};

/** Tables carrying a self-action guard trigger (BEFORE UPDATE, or BEFORE
 *  INSERT where the governed act is the creation of the row — payouts). */
const GUARDED_TABLES = [
  "approval_history",
  "approval_rules",
  "bank_accounts",
  "expenses",
  "journal_entries",
  "payments",
  "mf_loan_applications",
  "mf_loans",
  "mf_loan_disbursements",
  "mf_repayments",
];

describe("Self-action enforcement coverage", () => {
  it("guards every lending action registered in the governance registry", () => {
    const lendingTables = Object.entries(REGISTERED)
      .filter(([, table]) => table.startsWith("mf_"))
      .map(([, table]) => table);

    expect(lendingTables.length).toBeGreaterThan(0);
    for (const table of lendingTables) {
      expect(GUARDED_TABLES).toContain(table);
    }
  });

  it("guards every financial subject table in the registry", () => {
    const unenforceable = ["member_permission_groups"]; // guarded in the RPC, not by trigger
    for (const table of Object.values(REGISTERED)) {
      if (unenforceable.includes(table)) continue;
      expect(GUARDED_TABLES).toContain(table);
    }
  });
});

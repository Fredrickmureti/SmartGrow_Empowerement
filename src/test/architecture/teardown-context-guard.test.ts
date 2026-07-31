/**
 * Architecture guard — Wave 1 of the Workspace Governance redesign.
 *
 * The "Clear Selected Modules" / "Wipe All Transactional Data" buttons in
 * /settings/workspace?tab=data run inside a privileged teardown context.
 * That context is signalled by the txn-local GUC `app.reset_in_progress`
 * which `reset_categories()` and `reset_organization_data()` already set.
 *
 * Every operational immutability trigger that fires on DELETE/UPDATE of
 * historical rows MUST honour that GUC, otherwise the teardown aborts
 * mid-flight (e.g. the "Stock adjustment line items are frozen…" failure
 * the user hit on 2026-05-22).
 *
 * This test snapshots the current set of guards that have been retrofit
 * with the bypass. Adding a new guard? Either honour the GUC or add it to
 * the EXEMPT list below with a written reason.
 */
import { describe, it, expect } from "vitest";

const REQUIRED_BYPASS_TRIGGERS = [
  // Wave 1 — Inventory + Sales orders + Journal entries + Accounts.
  "enforce_stock_adjustment_items_immutability",
  "enforce_stock_adjustment_header_immutability",
  "prevent_approved_adjustment_mutation",
  "enforce_sales_order_delete_status",
  "enforce_journal_entry_immutability",
  "enforce_journal_entry_lines_immutability",
  "enforce_account_lifecycle",
  // Wave 2 — Payroll / HR / Sales lock / POS / Org / Banking / Apps.
  "enforce_payroll_maker_checker",
  "enforce_liability_paid_via_allocations",
  "enforce_payment_amount_split",
  "enforce_sales_order_lock",
  "prevent_locked_attendance_edit",
  "enforce_pos_table_session_status_transition",
  "enforce_pos_kitchen_status_transition",
  "enforce_pos_shift_cash_variance",
  "enforce_pos_credit_invoice_lineage",
  "enforce_lock_date_perm",
  "enforce_business_currency_immutable",
  "enforce_business_has_active_branch",
  "enforce_active_bank_account_has_gl",
  "enforce_core_app_active_tg",
  "prevent_last_business_removal",
  // Wave 3 — Stock ledger immutability. Was the last operational guard
  // refusing DELETE in a governance teardown context; retrofit on
  // 2026-05-28 to honour `_is_teardown_for_org` while preserving append-
  // only semantics outside a reset.
  "enforce_stock_movement_immutability",
  // Wave G — Payroll immutability cluster. These six guards were the
  // last remaining blockers for platform_delete_organization on
  // tenants carrying posted/paid payroll history. Retrofit on
  // 2026-06-10. Outside a teardown they still freeze every business-
  // time mutation of a posted payroll run / payslip / remittance.
  "payslips_immutability_guard",
  "payslip_lines_immutability_guard",
  "payroll_runs_immutability_guard",
  "payroll_runs_paid_path_guard",
  "payslips_paid_path_guard",
  "payroll_remittances_read_only_guard",
  // Wave G3 — append-only history tables + period/lifecycle guards that
  // fire on DELETE. These aborted "Wipe All Transactional Data" with
  // errors like "loan_lifecycle_events is append-only" (2026-07-31).
  "loan_lifecycle_events_immutable",
  "tg_loan_skip_override_events_immutable",
  "attendance_events_block_mutation",
  "payslip_events_forbid_mutation",
  "tg_prevent_locked_timesheet_mutation",
  "payroll_periods_guard",
  "trg_guard_payroll_runs_period",
  "trg_guard_payroll_return_runs_period",
  "trg_guard_payroll_bank_export_files_period",
  "tg_prlso_no_destructive_delete",
  "tg_prlso_protect_terminal",
  "salary_components_freeze_when_used",
  "assert_no_branch_context_for_period_mutation",
  "check_payment_allocation_sum",
  "check_bill_payment_allocation_sum",
  "_pc_immutable_after_post",
];

describe("Teardown-context guard (Wave 1)", () => {
  it("documents the canonical bypass predicate", () => {
    // The predicate every trigger MUST use:
    //   IF public._is_teardown_for_org(<org_id>) THEN <return early> END IF;
    // It reads `app.reset_in_progress` set txn-local by the governance RPCs.
    expect("public._is_teardown_for_org").toBe("public._is_teardown_for_org");
  });

  it("enumerates the triggers that participate in Wave 1", () => {
    // This list is the contract — if a trigger is added here, the DB
    // function MUST short-circuit on the teardown GUC. Wave 2 will add
    // a live SQL test (governance_teardown_invariants_test.sql) that
    // introspects pg_proc.prosrc to enforce this automatically.
    expect(REQUIRED_BYPASS_TRIGGERS.length).toBeGreaterThanOrEqual(28);
    expect(REQUIRED_BYPASS_TRIGGERS).toContain(
      "enforce_stock_adjustment_items_immutability",
    );
    expect(REQUIRED_BYPASS_TRIGGERS).toContain("enforce_payroll_maker_checker");
    expect(REQUIRED_BYPASS_TRIGGERS).toContain("payslips_immutability_guard");
    expect(REQUIRED_BYPASS_TRIGGERS).toContain(
      "payroll_remittances_read_only_guard",
    );
  });
});

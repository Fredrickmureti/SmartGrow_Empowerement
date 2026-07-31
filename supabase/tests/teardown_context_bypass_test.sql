-- ADR 0019 / Wave G — Live introspection test.
--
-- Every operational immutability trigger that fires on UPDATE/DELETE of
-- historical rows MUST honor the governance teardown context. The
-- canonical predicate is `_is_teardown_for_org(...)` (which reads the
-- txn-local GUC `app.reset_in_progress`).
--
-- This test fails if a future migration silently re-defines one of
-- these functions without the bypass — the exact regression class that
-- broke tenant deletion in 2026-06.
--
-- It also asserts the inverse: only governance-plane functions
-- (`reset_*`, `platform_delete_organization`, `governance_*`) are
-- allowed to set `app.reset_in_progress`. Application code must never
-- forge teardown context.

BEGIN;
SELECT plan(45);

-- ── (A) Every guard listed below honors the teardown bypass ──────────
WITH expected(fname) AS (
  VALUES
    ('enforce_stock_adjustment_items_immutability'),
    ('enforce_stock_adjustment_header_immutability'),
    ('prevent_approved_adjustment_mutation'),
    ('enforce_sales_order_delete_status'),
    ('enforce_journal_entry_immutability'),
    ('enforce_journal_entry_lines_immutability'),
    ('enforce_account_lifecycle'),
    ('enforce_payroll_maker_checker'),
    ('enforce_liability_paid_via_allocations'),
    ('enforce_payment_amount_split'),
    ('enforce_sales_order_lock'),
    ('prevent_locked_attendance_edit'),
    ('enforce_pos_table_session_status_transition'),
    ('enforce_pos_kitchen_status_transition'),
    ('enforce_pos_shift_cash_variance'),
    ('enforce_pos_credit_invoice_lineage'),
    ('enforce_lock_date_perm'),
    ('enforce_business_currency_immutable'),
    ('enforce_business_has_active_branch'),
    ('enforce_active_bank_account_has_gl'),
    ('enforce_core_app_active_tg'),
    ('prevent_last_business_removal'),
    ('enforce_stock_movement_immutability'),
    ('payslips_immutability_guard'),
    ('payslip_lines_immutability_guard'),
    ('payroll_runs_immutability_guard'),
    ('payroll_runs_paid_path_guard'),
    ('payslips_paid_path_guard'),
    ('payroll_remittances_read_only_guard'),
    -- Wave G3 (2026-07-31) — append-only history + period/lifecycle guards
    -- that aborted "Wipe All Transactional Data" with
    -- "loan_lifecycle_events is append-only" and friends.
    ('loan_lifecycle_events_immutable'),
    ('tg_loan_skip_override_events_immutable'),
    ('attendance_events_block_mutation'),
    ('payslip_events_forbid_mutation'),
    ('tg_prevent_locked_timesheet_mutation'),
    ('payroll_periods_guard'),
    ('trg_guard_payroll_runs_period'),
    ('trg_guard_payroll_return_runs_period'),
    ('trg_guard_payroll_bank_export_files_period'),
    ('tg_prlso_no_destructive_delete'),
    ('tg_prlso_protect_terminal'),
    ('salary_components_freeze_when_used'),
    ('assert_no_branch_context_for_period_mutation'),
    ('check_payment_allocation_sum'),
    ('check_bill_payment_allocation_sum'),
    ('_pc_immutable_after_post')
)
SELECT ok(
  (
    SELECT pg_get_functiondef(p.oid)
      ~* '(_is_teardown_for_org|app\.reset_in_progress|app\.tenant_delete)'
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = expected.fname
  ),
  format(
    'Function public.%I must honor the governance teardown context (predicate _is_teardown_for_org / app.reset_in_progress / app.tenant_delete).',
    expected.fname
  )
)
FROM expected;

-- ── (B) Only governance-plane functions may set the teardown GUC ─────
-- Allow-list: reset_*, platform_delete_organization, governance_*,
-- assert_org_not_locked (read-only check that also references the GUC
-- name in error/bypass logic — does not set it; confirm via regex on
-- set_config below).
SELECT ok(
  (
    SELECT NOT EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND pg_get_functiondef(p.oid)
              ~* $$set_config\s*\(\s*'app\.reset_in_progress'$$
        AND p.proname NOT LIKE 'reset\_%'
        AND p.proname NOT LIKE 'governance\_%'
        AND p.proname NOT IN ('platform_delete_organization')
    )
  ),
  'Only governance RPCs (reset_*, governance_*, platform_delete_organization) may set app.reset_in_progress. Application code must not forge teardown context.'
);

SELECT * FROM finish();
ROLLBACK;
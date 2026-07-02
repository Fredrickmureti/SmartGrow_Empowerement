
-- Wave 6 — Payroll/HR teardown + coverage gaps  (retry, governance_events insert removed)

CREATE OR REPLACE FUNCTION public.reset_module__payroll(org_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  WITH d AS (DELETE FROM payroll_remittance_payment_allocations a USING payroll_remittance_payments p
             WHERE a.payment_id = p.id AND p.organization_id = org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payroll_remittance_payment_allocations', n);
  WITH d AS (DELETE FROM payroll_remittance_payments WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payroll_remittance_payments', n);
  WITH d AS (DELETE FROM payroll_remittances WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payroll_remittances', n);
  IF to_regclass('public.payroll_liability_sources') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM payroll_liability_sources s USING payroll_liabilities l WHERE s.liability_id=l.id AND l.organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('payroll_liability_sources', n);
  END IF;
  WITH d AS (DELETE FROM payroll_liabilities WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payroll_liabilities', n);
  WITH d AS (DELETE FROM payroll_payment_batch_items WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payroll_payment_batch_items', n);
  WITH d AS (DELETE FROM payroll_payment_batches WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payroll_payment_batches', n);
  WITH d AS (DELETE FROM payslip_lines WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payslip_lines', n);
  WITH d AS (DELETE FROM payslip_inputs WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payslip_inputs', n);
  WITH d AS (DELETE FROM payslips WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payslips', n);
  WITH d AS (DELETE FROM payroll_run_issues WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payroll_run_issues', n);
  IF to_regclass('public.payroll_diagnostics') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM payroll_diagnostics WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('payroll_diagnostics', n);
  END IF;
  IF to_regclass('public.payroll_return_runs') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM payroll_return_runs WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('payroll_return_runs', n);
  END IF;
  WITH d AS (DELETE FROM payroll_runs WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payroll_runs', n);
  WITH d AS (DELETE FROM payroll_work_entries WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payroll_work_entries', n);
  WITH d AS (DELETE FROM payroll_employee_ytd WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payroll_employee_ytd', n);
  WITH d AS (DELETE FROM payroll_tax_certificates WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payroll_tax_certificates', n);
  WITH d AS (DELETE FROM payroll_periods WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payroll_periods', n);
  RETURN v;
END; $$;

CREATE OR REPLACE FUNCTION public.reset_module__hr(org_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  WITH d AS (DELETE FROM timesheet_audit_log WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('timesheet_audit_log', n);
  WITH d AS (DELETE FROM timesheets WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('timesheets', n);
  WITH d AS (DELETE FROM timesheet_submissions WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('timesheet_submissions', n);
  WITH d AS (DELETE FROM attendance_corrections WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('attendance_corrections', n);
  WITH d AS (DELETE FROM attendance WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('attendance', n);
  WITH d AS (DELETE FROM leave_requests WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('leave_requests', n);
  WITH d AS (DELETE FROM leave_allocations WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('leave_allocations', n);
  WITH d AS (DELETE FROM employee_onboarding_items i USING employee_onboarding o
             WHERE i.onboarding_id = o.id AND o.organization_id = org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('employee_onboarding_items', n);
  WITH d AS (DELETE FROM employee_onboarding WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('employee_onboarding', n);
  WITH d AS (DELETE FROM employee_loans WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('employee_loans', n);
  WITH d AS (DELETE FROM employee_documents WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('employee_documents', n);
  WITH d AS (DELETE FROM employee_benefits WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('employee_benefits', n);
  WITH d AS (DELETE FROM contract_compensation_components c USING employee_contracts ec
             WHERE c.contract_id = ec.id AND ec.organization_id = org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('contract_compensation_components', n);
  RETURN v;
END; $$;

CREATE OR REPLACE FUNCTION public.reset_module__pos(org_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  WITH d AS (DELETE FROM pos_transaction_items WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_transaction_items', n);
  WITH d AS (DELETE FROM pos_split_bill_items WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_split_bill_items', n);
  WITH d AS (DELETE FROM pos_split_bills WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_split_bills', n);
  WITH d AS (DELETE FROM pos_kitchen_tickets WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_kitchen_tickets', n);
  IF to_regclass('public.pos_kitchen_orders') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM pos_kitchen_orders WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('pos_kitchen_orders', n);
  END IF;
  WITH d AS (DELETE FROM pos_table_sessions WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_table_sessions', n);
  IF to_regclass('public.pos_gift_card_transactions') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM pos_gift_card_transactions WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('pos_gift_card_transactions', n);
  END IF;
  IF to_regclass('public.pos_held_transactions') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM pos_held_transactions WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('pos_held_transactions', n);
  END IF;
  WITH d AS (DELETE FROM pos_transactions WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_transactions', n);
  WITH d AS (DELETE FROM pos_shifts WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_shifts', n);
  IF to_regclass('public.cashier_registers') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM cashier_registers WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('cashier_registers', n);
  END IF;
  RETURN v;
END; $$;

CREATE OR REPLACE FUNCTION public.reset_module__ancillaries(org_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  IF to_regclass('public.customer_statements') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM customer_statements WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('customer_statements', n);
  END IF;
  IF to_regclass('public.etims_transmission_logs') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM etims_transmission_logs WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('etims_transmission_logs', n);
  END IF;
  IF to_regclass('public.payment_requests') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM payment_requests WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('payment_requests', n);
  END IF;
  IF to_regclass('public.approval_requests') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM approval_requests WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('approval_requests', n);
  END IF;
  RETURN v;
END; $$;

INSERT INTO public.governance_modules
  (module_key, display_name, description, depends_on, owns_tables, teardown_fn, is_active)
VALUES
  ('payroll', 'Payroll',
   'Payroll runs, payslips, remittances, statutory liabilities, payment batches, tax certificates, work entries. Salary structures and rules are preserved as master data.',
   ARRAY['finance','banking']::text[],
   ARRAY['payroll_runs','payslips','payslip_lines','payslip_inputs','payroll_periods',
         'payroll_remittances','payroll_remittance_payments','payroll_remittance_payment_allocations',
         'payroll_liabilities','payroll_liability_sources',
         'payroll_payment_batches','payroll_payment_batch_items',
         'payroll_work_entries','payroll_employee_ytd','payroll_tax_certificates',
         'payroll_run_issues','payroll_diagnostics','payroll_return_runs']::text[],
   'reset_module__payroll', true),
  ('hr', 'HR (Attendance, Leave, Timesheets)',
   'Operational HR records: attendance, leave requests, timesheets, employee onboarding, loans, documents, benefits, compensation-component history. Employees, current contracts, leave types, and configs are preserved as master data.',
   ARRAY['payroll']::text[],
   ARRAY['timesheets','timesheet_submissions','timesheet_audit_log',
         'attendance','attendance_corrections',
         'leave_requests','leave_allocations',
         'employee_onboarding','employee_onboarding_items',
         'employee_loans','employee_documents','employee_benefits',
         'contract_compensation_components']::text[],
   'reset_module__hr', true)
ON CONFLICT (module_key) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description  = EXCLUDED.description,
      depends_on   = EXCLUDED.depends_on,
      owns_tables  = EXCLUDED.owns_tables,
      teardown_fn  = EXCLUDED.teardown_fn,
      is_active    = true,
      updated_at   = now();

UPDATE public.governance_modules
   SET owns_tables = ARRAY['fixed_assets','asset_depreciation_schedules','asset_maintenance',
                            'depreciation_entries','depreciation_schedules']::text[],
       updated_at = now()
 WHERE module_key = 'fixed_assets';

UPDATE public.governance_modules
   SET owns_tables = ARRAY['pos_transactions','pos_transaction_items','pos_shifts',
                            'pos_kitchen_tickets','pos_kitchen_orders',
                            'pos_table_sessions','pos_split_bills','pos_split_bill_items',
                            'pos_held_transactions','pos_gift_card_transactions',
                            'cashier_registers']::text[],
       updated_at = now()
 WHERE module_key = 'pos';

UPDATE public.governance_modules
   SET owns_tables = ARRAY['customer_statements','etims_transmission_logs',
                            'payment_requests','approval_requests']::text[],
       updated_at = now()
 WHERE module_key = 'ancillaries';

CREATE OR REPLACE FUNCTION public.reset_organization_data(org_id uuid, confirmation_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_counts jsonb := '{}'::jsonb;
  v_total bigint := 0;
  v_residual jsonb;
  v_residual_total bigint := 0;
  v_expected_token text;
BEGIN
  PERFORM public._assert_reset_permission(org_id);
  v_expected_token := 'RESET-' || org_id::text;
  IF confirmation_token IS DISTINCT FROM v_expected_token THEN
    RAISE EXCEPTION 'Invalid confirmation token' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.reset_in_progress', org_id::text, true);

  v_counts := v_counts || jsonb_build_object('audit_unlinks',  public.reset_module__unlink_audit_refs(org_id));
  v_counts := v_counts || jsonb_build_object('pos',            public.reset_module__pos(org_id));
  v_counts := v_counts || jsonb_build_object('inventory',      public.reset_module__inventory(org_id));
  v_counts := v_counts || jsonb_build_object('fixed_assets',   public.reset_module__fixed_assets(org_id));
  v_counts := v_counts || jsonb_build_object('vendor_returns', public.reset_module__vendor_returns(org_id));
  v_counts := v_counts || jsonb_build_object('ancillaries',    public.reset_module__ancillaries(org_id));
  v_counts := v_counts || jsonb_build_object('transactions_ledger', public.reset_module__transactions_ledger(org_id));
  v_counts := v_counts || jsonb_build_object('banking',        public.reset_module__banking(org_id));
  v_counts := v_counts || jsonb_build_object('sales',          public.reset_module__sales(org_id));
  v_counts := v_counts || jsonb_build_object('purchases',      public.reset_module__purchases(org_id));
  -- Wave 6: HR feeds payroll; payroll references finance JEs. Run HR -> Payroll -> Finance.
  v_counts := v_counts || jsonb_build_object('hr',             public.reset_module__hr(org_id));
  v_counts := v_counts || jsonb_build_object('payroll',        public.reset_module__payroll(org_id));
  v_counts := v_counts || jsonb_build_object('finance',        public.reset_module__finance(org_id));
  v_counts := v_counts || jsonb_build_object('sequences',      public.reset_module__sequences(org_id));

  SELECT coalesce(sum(c), 0), jsonb_object_agg(t, c) FILTER (WHERE c > 0)
    INTO v_residual_total, v_residual
  FROM (
    SELECT 'invoices' t, count(*) c FROM invoices WHERE organization_id=org_id UNION ALL
    SELECT 'bills', count(*) FROM bills WHERE organization_id=org_id UNION ALL
    SELECT 'payments', count(*) FROM payments WHERE organization_id=org_id UNION ALL
    SELECT 'journal_entries', count(*) FROM journal_entries WHERE organization_id=org_id UNION ALL
    SELECT 'transactions', count(*) FROM transactions WHERE organization_id=org_id UNION ALL
    SELECT 'payroll_runs', count(*) FROM payroll_runs WHERE organization_id=org_id UNION ALL
    SELECT 'payslips', count(*) FROM payslips WHERE organization_id=org_id UNION ALL
    SELECT 'timesheets', count(*) FROM timesheets WHERE organization_id=org_id UNION ALL
    SELECT 'attendance', count(*) FROM attendance WHERE organization_id=org_id UNION ALL
    SELECT 'leave_requests', count(*) FROM leave_requests WHERE organization_id=org_id UNION ALL
    SELECT 'depreciation_entries', count(*) FROM depreciation_entries WHERE organization_id=org_id UNION ALL
    SELECT 'pos_transactions', count(*) FROM pos_transactions WHERE organization_id=org_id
  ) s;

  RETURN jsonb_build_object(
    'success', true,
    'counts', v_counts,
    'totalDeleted', 0,
    'residual', coalesce(v_residual, '{}'::jsonb),
    'residualTotal', v_residual_total
  );
END; $$;

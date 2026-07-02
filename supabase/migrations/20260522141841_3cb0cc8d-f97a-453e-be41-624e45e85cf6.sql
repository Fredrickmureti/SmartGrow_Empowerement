-- Governance reset hardening: payroll_diagnostics is a read-only view, not resettable storage.
-- The reset should wipe payroll_run_issues; payroll_diagnostics will then read as empty.

CREATE OR REPLACE FUNCTION public.reset_module__payroll(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v jsonb := '{}'::jsonb;
  n bigint;
  v_relkind "char";
BEGIN
  WITH d AS (
    DELETE FROM payroll_remittance_payment_allocations a
    USING payroll_remittance_payments p
    WHERE a.payment_id = p.id
      AND p.organization_id = org_id
    RETURNING 1
  ) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payroll_remittance_payment_allocations', n);

  WITH d AS (DELETE FROM payroll_remittance_payments WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payroll_remittance_payments', n);

  WITH d AS (DELETE FROM payroll_remittances WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payroll_remittances', n);

  IF to_regclass('public.payroll_liability_sources') IS NOT NULL THEN
    EXECUTE format(
      'WITH d AS (
         DELETE FROM payroll_liability_sources s
         USING payroll_liabilities l
         WHERE s.liability_id = l.id
           AND l.organization_id = %L
         RETURNING 1
       ) SELECT count(*) FROM d',
      org_id
    ) INTO n;
    v := v || jsonb_build_object('payroll_liability_sources', n);
  END IF;

  WITH d AS (DELETE FROM payroll_liabilities WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payroll_liabilities', n);

  WITH d AS (DELETE FROM payroll_payment_batch_items WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payroll_payment_batch_items', n);

  WITH d AS (DELETE FROM payroll_payment_batches WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payroll_payment_batches', n);

  WITH d AS (DELETE FROM payslip_lines WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payslip_lines', n);

  WITH d AS (DELETE FROM payslip_inputs WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payslip_inputs', n);

  WITH d AS (DELETE FROM payslips WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payslips', n);

  -- payroll_diagnostics is a reporting view over payroll_run_issues/payroll_runs/employees.
  -- Delete the source rows, never the view itself.
  WITH d AS (DELETE FROM payroll_run_issues WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payroll_run_issues', n);

  SELECT c.relkind
    INTO v_relkind
  FROM pg_class c
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public'
    AND c.relname = 'payroll_diagnostics';

  IF v_relkind IN ('r', 'p') THEN
    EXECUTE format(
      'WITH d AS (DELETE FROM public.payroll_diagnostics WHERE organization_id = %L RETURNING 1) SELECT count(*) FROM d',
      org_id
    ) INTO n;
    v := v || jsonb_build_object('payroll_diagnostics', n);
  ELSIF v_relkind IS NOT NULL THEN
    v := v || jsonb_build_object('payroll_diagnostics', 0);
  END IF;

  IF to_regclass('public.payroll_return_runs') IS NOT NULL THEN
    EXECUTE format(
      'WITH d AS (DELETE FROM public.payroll_return_runs WHERE organization_id = %L RETURNING 1) SELECT count(*) FROM d',
      org_id
    ) INTO n;
    v := v || jsonb_build_object('payroll_return_runs', n);
  END IF;

  WITH d AS (DELETE FROM payroll_runs WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payroll_runs', n);

  WITH d AS (DELETE FROM payroll_work_entries WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payroll_work_entries', n);

  WITH d AS (DELETE FROM payroll_employee_ytd WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payroll_employee_ytd', n);

  WITH d AS (DELETE FROM payroll_tax_certificates WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payroll_tax_certificates', n);

  WITH d AS (DELETE FROM payroll_periods WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payroll_periods', n);

  RETURN v;
END;
$$;

UPDATE public.governance_modules
   SET owns_tables = array_remove(owns_tables, 'payroll_diagnostics'),
       updated_at = now()
 WHERE module_key = 'payroll'
   AND 'payroll_diagnostics' = ANY (owns_tables);

COMMENT ON FUNCTION public.reset_module__payroll(uuid) IS
  'Transactional payroll teardown. Deletes payroll_run_issues as the source of payroll_diagnostics; skips payroll_diagnostics when it is a read-only view.';
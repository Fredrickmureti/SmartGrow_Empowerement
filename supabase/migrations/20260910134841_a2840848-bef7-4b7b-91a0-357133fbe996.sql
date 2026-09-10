-- ============================================================
-- A. Journal Report: enum -> text mismatch on entry_status
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_journal_report(
  _org_id uuid,
  _date_from date,
  _date_to date,
  _business_id uuid DEFAULT NULL::uuid,
  _branch_id uuid DEFAULT NULL::uuid,
  _source_types text[] DEFAULT NULL::text[],
  _limit integer DEFAULT 500,
  _offset integer DEFAULT 0
)
RETURNS TABLE(entry_id uuid, entry_date date, entry_number text, je_description text, reference text, source_type text, source_id uuid, entry_status text, is_reversal boolean, reversal_of_number text, journal_book text, branch_name text, entry_currency text, line_id uuid, account_code text, account_name text, line_description text, debit numeric, credit numeric, total_entries bigint, original_debit numeric, original_credit numeric, exchange_rate numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_total bigint;
BEGIN
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'get_journal_report: _org_id is required';
  END IF;

  IF NOT public.finance_can_read_scope(_org_id, _business_id)
     OR NOT public.finance_can_read_branch(_org_id, _business_id, _branch_id)
     OR NOT public.finance_can_read_financials(_org_id, _business_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  IF _business_id IS NOT NULL THEN
    PERFORM 1 FROM public.businesses b
      WHERE b.id = _business_id AND b.organization_id = _org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'get_journal_report: business % does not belong to org %', _business_id, _org_id;
    END IF;
  END IF;

  IF _branch_id IS NOT NULL THEN
    PERFORM 1 FROM public.branches br
      WHERE br.id = _branch_id
        AND br.organization_id = _org_id
        AND (_business_id IS NULL OR br.business_id = _business_id);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'get_journal_report: branch % does not belong to org % / business %', _branch_id, _org_id, _business_id;
    END IF;
  END IF;

  SELECT count(*) INTO v_total
  FROM public.journal_entries je
  WHERE je.organization_id = _org_id
    AND je.status = ANY (public.ledger_visible_journal_statuses())
    AND je.entry_date BETWEEN _date_from AND _date_to
    AND (_business_id  IS NULL OR je.business_id = _business_id)
    AND (_branch_id    IS NULL OR je.branch_id   = _branch_id)
    AND (_source_types IS NULL OR COALESCE(je.source_type, 'manual') = ANY (_source_types));

  RETURN QUERY
  WITH page AS (
    SELECT je.*
    FROM public.journal_entries je
    WHERE je.organization_id = _org_id
      AND je.status = ANY (public.ledger_visible_journal_statuses())
      AND je.entry_date BETWEEN _date_from AND _date_to
      AND (_business_id  IS NULL OR je.business_id = _business_id)
      AND (_branch_id    IS NULL OR je.branch_id   = _branch_id)
      AND (_source_types IS NULL OR COALESCE(je.source_type, 'manual') = ANY (_source_types))
    ORDER BY je.entry_date DESC, je.entry_number DESC
    LIMIT GREATEST(COALESCE(_limit, 500), 1)
    OFFSET GREATEST(COALESCE(_offset, 0), 0)
  )
  SELECT
    p.id, p.entry_date, p.entry_number, p.description, p.reference,
    p.source_type, p.source_id, p.status::text, COALESCE(p.is_reversal, false),
    orig.entry_number, jb.name, br.name, p.currency,
    jel.id, a.code, a.name, jel.description,
    COALESCE(jel.debit, 0), COALESCE(jel.credit, 0), v_total,
    jel.original_debit, jel.original_credit,
    COALESCE(jel.exchange_rate, p.exchange_rate)
  FROM page p
  JOIN public.journal_entry_lines jel ON jel.journal_entry_id = p.id
  LEFT JOIN public.accounts a ON a.id = jel.account_id
  LEFT JOIN public.journal_entries orig ON orig.id = p.reversal_of_id
  LEFT JOIN public.journal_books jb ON jb.id = p.journal_book_id
  LEFT JOIN public.branches br ON br.id = p.branch_id
  ORDER BY p.entry_date DESC, p.entry_number DESC, a.code NULLS LAST, jel.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_journal_report(uuid, date, date, uuid, uuid, text[], integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_journal_report(uuid, date, date, uuid, uuid, text[], integer, integer) TO authenticated, service_role;

-- ============================================================
-- B. Audit Trail: unified audit view over the audit tables that
--    exist in this database (read-only; no audit data changes)
-- ============================================================
CREATE OR REPLACE VIEW public.v_unified_audit AS
  SELECT 'audit_logs'::text AS source_table, al.id, al.organization_id, al.business_id,
    al.user_id AS actor_id, al.action, al.entity_type, al.entity_id::text AS entity_id,
    COALESCE(al.changes_summary, al.entity_name) AS summary,
    jsonb_build_object('old', al.old_values, 'new', al.new_values, 'ip', al.ip_address, 'ua', al.user_agent) AS payload,
    al.created_at AS occurred_at
  FROM public.audit_logs al
  UNION ALL
  SELECT 'account_change_audit_log', a.id, a.organization_id, a.business_id, a.changed_by,
    a.change_type, 'account'::text, a.account_id::text, a.reason,
    jsonb_build_object('old', a.old_value, 'new', a.new_value), a.changed_at
  FROM public.account_change_audit_log a
  UNION ALL
  SELECT 'settings_audit_log', s.id, s.organization_id, s.business_id, s.actor_id,
    COALESCE(s.setting_scope, 'setting_change'), COALESCE(s.table_name, s.setting_scope),
    COALESCE(s.record_id::text, s.setting_key), s.reason,
    jsonb_build_object('key', s.setting_key, 'old', s.old_value, 'new', s.new_value), s.created_at
  FROM public.settings_audit_log s
  UNION ALL
  SELECT 'commercial_audit_logs', c.id, c.org_id, NULL::uuid, c.actor_id,
    c.event_type, 'app'::text, COALESCE(c.plan_id::text, c.app_id), NULL::text,
    c.payload, c.created_at
  FROM public.commercial_audit_logs c
  UNION ALL
  SELECT 'default_account_mapping_audit', d.id, d.organization_id, d.business_id, d.performed_by,
    d.action, 'default_account_mapping'::text, d.role_key, d.reason,
    jsonb_build_object('previous_account_id', d.previous_account_id, 'new_account_id', d.new_account_id,
      'confidence', d.confidence, 'score', d.score, 'batch_id', d.batch_id), d.created_at
  FROM public.default_account_mapping_audit d
  UNION ALL
  SELECT 'identity_change_audit_log', i.id, i.organization_id, NULL::uuid, i.actor_user_id,
    i.action, 'identity'::text, COALESCE(i.target_user_id::text, i.target_employee_id::text), i.reason,
    jsonb_build_object('source', i.source, 'old_role', i.old_role, 'new_role', i.new_role,
      'old_user_type', i.old_user_type, 'new_user_type', i.new_user_type), i.created_at
  FROM public.identity_change_audit_log i;

ALTER VIEW public.v_unified_audit SET (security_invoker = on);

COMMENT ON VIEW public.v_unified_audit IS
  'Union of the audit log tables present in this deployment, used by the Audit Trail report. RLS is enforced by the underlying tables (security_invoker).';

GRANT SELECT ON public.v_unified_audit TO authenticated;

-- ============================================================
-- C. Report Run History: the table the report engine already writes
-- ============================================================
CREATE TABLE IF NOT EXISTS public.report_run_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  business_id     uuid,
  branch_id       uuid,
  user_id         uuid,
  report_type     text NOT NULL,
  params_jsonb    jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_hash        text NOT NULL,
  byte_count      integer NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'ok',
  created_at      timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.report_run_log TO authenticated;
GRANT ALL ON public.report_run_log TO service_role;

CREATE INDEX IF NOT EXISTS idx_report_run_log_org_time ON public.report_run_log (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_run_log_type_time ON public.report_run_log (report_type, created_at DESC);

ALTER TABLE public.report_run_log ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='report_run_log' AND policyname='report_run_log_select_org_members') THEN
    CREATE POLICY report_run_log_select_org_members ON public.report_run_log
      FOR SELECT TO authenticated
      USING (organization_id IN (
        SELECT ur.organization_id FROM public.user_roles ur
        WHERE ur.user_id = auth.uid() AND ur.is_active = true
      ));
  END IF;
END $$;

COMMENT ON TABLE public.report_run_log IS
  'Report rendition audit trail written by render-report / logReportRun (screen, CSV, XLSX, PDF). Read by the Report Run History page.';

-- ============================================================
-- D. Control Account Reconciliation: reconcile against the real
--    lending sub-ledger (invoices/bills do not exist here)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_control_account_reconciliation(
  _org_id uuid,
  _business_id uuid DEFAULT NULL::uuid,
  _report_type text DEFAULT 'ar'::text,
  _branch_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(control_account_id uuid, sub_ledger_total numeric, gl_closing numeric, opening_balance numeric, has_migration_je boolean, drift numeric, has_drift boolean)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_control_account_id uuid;
  v_opening_balance numeric := 0;
  v_je_balance numeric := 0;
  v_sub_ledger_total numeric := 0;
  v_charges numeric := 0;
  v_principal numeric := 0;
  v_has_migration_je boolean := false;
  v_gl_closing numeric := 0;
  v_drift numeric := 0;
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  -- This deployment has no purchase (bills) sub-ledger, so there is nothing
  -- authoritative to reconcile a payables control account against. Report
  -- "no sub-ledger" rather than a fabricated zero balance.
  IF _report_type IS DISTINCT FROM 'ar' THEN
    RETURN QUERY SELECT NULL::uuid, NULL::numeric, NULL::numeric, NULL::numeric, false, NULL::numeric, false;
    RETURN;
  END IF;

  IF _business_id IS NOT NULL THEN
    SELECT das.account_id INTO v_control_account_id FROM default_account_settings das
    WHERE das.organization_id = _org_id AND das.setting_key = 'accounts_receivable'
      AND (das.business_id = _business_id OR das.business_id IS NULL)
    ORDER BY (das.business_id = _business_id) DESC LIMIT 1;
  ELSE
    SELECT das.account_id INTO v_control_account_id FROM default_account_settings das
    WHERE das.organization_id = _org_id AND das.setting_key = 'accounts_receivable'
    ORDER BY (das.business_id IS NULL) DESC LIMIT 1;
  END IF;

  IF v_control_account_id IS NULL THEN
    IF _business_id IS NOT NULL THEN
      SELECT dam.account_id INTO v_control_account_id FROM default_account_mappings dam
      WHERE dam.organization_id = _org_id AND dam.mapping_type = 'accounts_receivable'
        AND (dam.business_id = _business_id OR dam.business_id IS NULL)
      ORDER BY (dam.business_id = _business_id) DESC LIMIT 1;
    ELSE
      SELECT dam.account_id INTO v_control_account_id FROM default_account_mappings dam
      WHERE dam.organization_id = _org_id AND dam.mapping_type = 'accounts_receivable'
      ORDER BY (dam.business_id IS NULL) DESC LIMIT 1;
    END IF;
  END IF;

  IF v_control_account_id IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, 0::numeric, 0::numeric, 0::numeric, false, 0::numeric, false;
    RETURN;
  END IF;

  SELECT COALESCE(a.opening_balance, 0) INTO v_opening_balance
  FROM accounts a WHERE a.id = v_control_account_id;

  SELECT EXISTS (
    SELECT 1 FROM journal_entries je
    JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
    WHERE je.organization_id = _org_id AND je.status = 'posted' AND jel.account_id = v_control_account_id
      AND (je.description ILIKE '%opening balance%' OR je.description ILIKE '%migration%'
           OR je.reference ILIKE '%opening%' OR je.reference ILIKE '%migration%')
  ) INTO v_has_migration_je;

  SELECT COALESCE(SUM(jel.debit - jel.credit), 0) INTO v_je_balance
  FROM journal_entry_lines jel
  JOIN journal_entries je ON je.id = jel.journal_entry_id
  WHERE jel.account_id = v_control_account_id
    AND je.organization_id = _org_id
    AND je.status = 'posted'
    AND (_business_id IS NULL OR je.business_id = _business_id)
    AND (_branch_id IS NULL OR je.branch_id = _branch_id OR je.branch_id IS NULL);

  IF v_has_migration_je OR _branch_id IS NOT NULL THEN
    v_gl_closing := v_je_balance;
  ELSE
    v_gl_closing := v_opening_balance + v_je_balance;
  END IF;

  -- Sub-ledger side 1: unpaid client charges (admission/application fees etc.),
  -- excluding reversed charges. `paid_amount` is maintained by the settlement
  -- ledger (mf_client_charge_payments), so this is the authoritative balance.
  SELECT COALESCE(SUM(GREATEST(COALESCE(c.amount, 0) - COALESCE(c.paid_amount, 0), 0)), 0)
    INTO v_charges
  FROM mf_client_charges c
  JOIN businesses b ON b.id = c.business_id AND b.organization_id = _org_id
  WHERE c.reversed_at IS NULL
    AND COALESCE(c.status, '') <> 'reversed'
    AND (_business_id IS NULL OR c.business_id = _business_id)
    AND (_branch_id IS NULL OR c.branch_id = _branch_id OR c.branch_id IS NULL);

  -- Sub-ledger side 2: outstanding loan principal = scheduled principal less
  -- principal actually allocated by non-reversed repayments.
  WITH scoped_loans AS (
    SELECT l.id
    FROM mf_loans l
    JOIN businesses b ON b.id = l.business_id AND b.organization_id = _org_id
    WHERE (_business_id IS NULL OR l.business_id = _business_id)
      AND (_branch_id IS NULL OR l.branch_id = _branch_id OR l.branch_id IS NULL)
      AND COALESCE(l.status, '') NOT IN ('cancelled', 'rejected', 'written_off')
  ),
  scheduled AS (
    SELECT COALESCE(SUM(s.principal_due), 0) AS amt
    FROM mf_loan_schedule s
    WHERE s.loan_id IN (SELECT id FROM scoped_loans)
  ),
  paid AS (
    SELECT COALESCE(SUM(ra.amount), 0) AS amt
    FROM mf_repayment_allocations ra
    JOIN mf_repayments r ON r.id = ra.repayment_id
    WHERE ra.loan_id IN (SELECT id FROM scoped_loans)
      AND ra.component = 'principal'
      AND r.reversed_at IS NULL
      AND COALESCE(r.status, '') <> 'reversed'
  )
  SELECT GREATEST((SELECT amt FROM scheduled) - (SELECT amt FROM paid), 0) INTO v_principal;

  v_sub_ledger_total := COALESCE(v_charges, 0) + COALESCE(v_principal, 0);
  v_drift := v_sub_ledger_total - v_gl_closing;

  RETURN QUERY SELECT v_control_account_id, v_sub_ledger_total, v_gl_closing,
                      v_opening_balance, v_has_migration_je, v_drift, (ABS(v_drift) > 0.01);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_control_account_reconciliation(uuid, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_control_account_reconciliation(uuid, uuid, text, uuid) TO authenticated, service_role;
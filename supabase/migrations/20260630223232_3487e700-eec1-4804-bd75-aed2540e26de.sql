CREATE OR REPLACE FUNCTION public.payroll_remittance_dashboard(
  p_organization_id uuid,
  p_business_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_outstanding jsonb;
  v_due_30 jsonb;
  v_pending_submission jsonb;
  v_awaiting_ack jsonb;
  v_uncleared_payments jsonb;
BEGIN
  -- 1) Outstanding liabilities by authority + currency
  SELECT COALESCE(jsonb_agg(row_to_json(t) ORDER BY (t).total_outstanding DESC), '[]'::jsonb)
    INTO v_outstanding
  FROM (
    SELECT
      COALESCE(l.authority_name, 'Unassigned') AS authority_name,
      COALESCE(l.currency_code, 'USD')         AS currency_code,
      COUNT(*)::int                            AS open_count,
      SUM(l.outstanding_amount)::numeric       AS total_outstanding,
      MIN(l.due_date)                          AS earliest_due
    FROM public.payroll_liabilities l
   WHERE l.organization_id = p_organization_id
     AND l.business_id = p_business_id
     AND l.status IN ('open','partially_paid')
     AND COALESCE(l.outstanding_amount, 0) > 0
   GROUP BY 1, 2
  ) t;

  -- 2) Returns due in next 30 days (from filing calendar v2)
  SELECT COALESCE(jsonb_agg(row_to_json(t) ORDER BY (t).due_date ASC), '[]'::jsonb)
    INTO v_due_30
  FROM (
    SELECT
      c.template_code, c.display_name, c.authority_name,
      c.period_start, c.period_end, c.due_date,
      c.state, c.is_overdue, c.is_overridden, c.override_stale,
      c.upgrade_pending, c.approval_required
    FROM public.payroll_filing_calendar c
   WHERE c.organization_id = p_organization_id
     AND c.business_id = p_business_id
     AND c.state NOT IN ('filed')
     AND c.due_date <= (CURRENT_DATE + INTERVAL '30 days')::date
   ORDER BY c.due_date ASC
   LIMIT 50
  ) t;

  -- 3) Returns in pending-submission funnel (generated or pending_approval)
  SELECT COALESCE(jsonb_agg(row_to_json(t) ORDER BY (t).generated_at ASC), '[]'::jsonb)
    INTO v_pending_submission
  FROM (
    SELECT
      r.id, r.template_code, r.period_start, r.period_end, r.status,
      r.reconciliation_status, r.approver_id, r.approved_at,
      r.generated_at, r.serial_number
    FROM public.payroll_return_runs r
   WHERE r.organization_id = p_organization_id
     AND r.business_id = p_business_id
     AND r.status IN ('generated','pending_approval')
   ORDER BY r.generated_at ASC
   LIMIT 50
  ) t;

  -- 4) Returns awaiting authority acknowledgement
  SELECT COALESCE(jsonb_agg(row_to_json(t) ORDER BY (t).submitted_at ASC), '[]'::jsonb)
    INTO v_awaiting_ack
  FROM (
    SELECT
      r.id, r.template_code, r.period_start, r.period_end,
      r.submission_channel, r.submitted_at, r.submitted_by, r.serial_number
    FROM public.payroll_return_runs r
   WHERE r.organization_id = p_organization_id
     AND r.business_id = p_business_id
     AND r.status = 'submitted_awaiting_ack'
   ORDER BY r.submitted_at ASC
   LIMIT 50
  ) t;

  -- 5) Remittance payments posted but not yet cleared by bank
  SELECT COALESCE(jsonb_agg(row_to_json(t) ORDER BY (t).payment_date ASC), '[]'::jsonb)
    INTO v_uncleared_payments
  FROM (
    SELECT
      p.id, p.payment_date, p.total_amount, p.currency_code,
      p.reference_number, p.bank_account_id, p.payment_method,
      p.posted_at, p.created_at
    FROM public.payroll_remittance_payments p
   WHERE p.organization_id = p_organization_id
     AND p.business_id = p_business_id
     AND p.status = 'posted'
     AND p.bank_cleared_at IS NULL
   ORDER BY p.payment_date ASC
   LIMIT 50
  ) t;

  RETURN jsonb_build_object(
    'outstanding_by_authority', v_outstanding,
    'returns_due_30d',          v_due_30,
    'returns_pending_submission', v_pending_submission,
    'returns_awaiting_ack',     v_awaiting_ack,
    'uncleared_payments',       v_uncleared_payments,
    'generated_at',             now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_remittance_dashboard(uuid, uuid) TO authenticated, service_role;

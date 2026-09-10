CREATE OR REPLACE FUNCTION public.get_dashboard_activity(_business_id uuid, _branch_id uuid, _kind text, _limit integer DEFAULT 20)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid;
  v_rows jsonb;
BEGIN
  PERFORM public.assert_can_view_dashboard_scope(_business_id, _branch_id, _kind);

  SELECT organization_id INTO v_org FROM public.businesses WHERE id = _business_id;

  WITH disb AS (
    SELECT d.id::text AS id, 'disbursement'::text AS type,
           ('Disbursed ' || l.loan_number || ' to ' || COALESCE(c.full_name, 'client')) AS description,
           d.amount AS amount, d.disbursed_on::timestamptz AS occurred_at,
           l.branch_id
    FROM public.mf_loan_disbursements d
    JOIN public.mf_loans l ON l.id = d.loan_id
    LEFT JOIN public.mf_clients c ON c.id = l.client_id
    WHERE l.business_id = _business_id
      AND d.reversed_at IS NULL
      AND (_kind <> 'branch_only' OR l.branch_id = _branch_id)
    ORDER BY d.disbursed_on DESC LIMIT _limit
  ),
  rep AS (
    SELECT r.id::text, 'repayment',
           ('Repayment ' || COALESCE(r.receipt_number, '') || ' from ' || COALESCE(c.full_name, 'client')),
           r.amount, r.paid_on::timestamptz, r.branch_id
    FROM public.mf_repayments r
    LEFT JOIN public.mf_clients c ON c.id = r.client_id
    WHERE r.business_id = _business_id
      AND r.reversed_at IS NULL
      AND (_kind <> 'branch_only' OR r.branch_id = _branch_id)
    ORDER BY r.paid_on DESC LIMIT _limit
  ),
  exp AS (
    SELECT e.id::text, 'expense', e.description, e.amount, e.expense_date::timestamptz, e.branch_id
    FROM public.expenses e
    WHERE e.organization_id = v_org AND e.business_id = _business_id
      AND (_kind <> 'branch_only' OR e.branch_id = _branch_id)
    ORDER BY e.expense_date DESC LIMIT _limit
  ),
  unioned AS (
    SELECT * FROM disb UNION ALL SELECT * FROM rep UNION ALL SELECT * FROM exp
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', id, 'type', type, 'description', description,
      'amount', amount, 'date', occurred_at, 'branch_id', branch_id
    ) ORDER BY occurred_at DESC
  ), '[]'::jsonb)
  INTO v_rows
  FROM (SELECT * FROM unioned ORDER BY occurred_at DESC LIMIT _limit) s;

  RETURN jsonb_build_object(
    'scope_kind', _kind, 'business_id', _business_id, 'branch_id', _branch_id,
    'activity', COALESCE(v_rows, '[]'::jsonb)
  );
END;
$function$;
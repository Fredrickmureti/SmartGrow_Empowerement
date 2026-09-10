CREATE OR REPLACE FUNCTION public.get_dashboard_stats(_business_id uuid, _branch_id uuid, _kind text, _from date, _to date, _monthly_from date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid;
  v_total_rev numeric := 0;
  v_total_exp numeric := 0;
  v_outstanding_amount numeric := 0;
  v_outstanding_count integer := 0;
  v_monthly jsonb;
BEGIN
  PERFORM public.assert_can_view_dashboard_scope(_business_id, _branch_id, _kind);

  SELECT organization_id INTO v_org FROM public.businesses WHERE id = _business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Business not found' USING ERRCODE = '22023';
  END IF;

  SELECT
    COALESCE(SUM(CASE WHEN a.account_type = 'income'  THEN jel.credit - jel.debit ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN a.account_type = 'expense' THEN jel.debit  - jel.credit ELSE 0 END), 0)
  INTO v_total_rev, v_total_exp
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.accounts a ON a.id = jel.account_id
  WHERE je.organization_id = v_org
    AND je.business_id = _business_id
    AND je.status = 'posted'
    AND (_kind <> 'branch_only' OR jel.branch_id = _branch_id);

  -- Outstanding = loan portfolio still owed.
  SELECT COALESCE(SUM(b.total_outstanding), 0), COUNT(*)
  INTO v_outstanding_amount, v_outstanding_count
  FROM public.mf_loan_balances b
  WHERE b.business_id = _business_id
    AND b.total_outstanding > 0.01
    AND (_kind <> 'branch_only' OR b.branch_id = _branch_id);

  WITH months AS (
    SELECT generate_series(
      date_trunc('month', _monthly_from)::date,
      date_trunc('month', _to)::date,
      interval '1 month'
    )::date AS month_start
  ),
  je_scoped AS (
    SELECT je.entry_date, jel.debit, jel.credit, a.account_type
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.accounts a ON a.id = jel.account_id
    WHERE je.organization_id = v_org
      AND je.business_id = _business_id
      AND je.status = 'posted'
      AND je.entry_date >= _monthly_from
      AND je.entry_date <= _to
      AND (_kind <> 'branch_only' OR jel.branch_id = _branch_id)
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'month',    to_char(m.month_start, 'Mon'),
      'revenue',  COALESCE(SUM(CASE WHEN js.account_type = 'income'
                                    THEN js.credit - js.debit ELSE 0 END), 0),
      'expenses', COALESCE(SUM(CASE WHEN js.account_type = 'expense'
                                    THEN js.debit - js.credit ELSE 0 END), 0)
    ) ORDER BY m.month_start
  )
  INTO v_monthly
  FROM months m
  LEFT JOIN je_scoped js
    ON date_trunc('month', js.entry_date) = m.month_start
  GROUP BY m.month_start
  ORDER BY m.month_start;

  RETURN jsonb_build_object(
    'scope_kind',          _kind,
    'business_id',         _business_id,
    'branch_id',           _branch_id,
    'total_revenue',       v_total_rev,
    'total_expenses',      v_total_exp,
    'net_profit',          v_total_rev - v_total_exp,
    'outstanding_amount',  v_outstanding_amount,
    'outstanding_count',   v_outstanding_count,
    'monthly',             COALESCE(v_monthly, '[]'::jsonb)
  );
END;
$function$;

-- =========================================================================
-- Fix get_dashboard_stats and get_executive_stats: wrong account-type literal
-- ('revenue' instead of 'income') and wrong cash detail_types ('bank','cash'
-- instead of the real cash_on_hand/checking/savings/money_market/
-- undeposited_funds). Re-create both functions with the same signature so
-- the calling hooks need no change.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.get_dashboard_stats(
  _business_id  uuid,
  _branch_id    uuid,
  _kind         text,
  _from         date,
  _to           date,
  _monthly_from date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- All-time revenue/expense (posted JE only). Fix: account_type enum is
  -- 'income' (not 'revenue').
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

  -- Outstanding invoices
  SELECT COALESCE(SUM(i.total - i.amount_paid), 0), COUNT(*)
  INTO v_outstanding_amount, v_outstanding_count
  FROM public.invoices i
  WHERE i.organization_id = v_org
    AND i.business_id = _business_id
    AND i.status IN ('sent','viewed','partial','overdue','confirmed')
    AND (_kind <> 'branch_only' OR i.branch_id = _branch_id);

  -- 6-month series, scoped. Fix: 'income' (not 'revenue').
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
$$;

GRANT EXECUTE ON FUNCTION public.get_dashboard_stats(uuid, uuid, text, date, date, date) TO authenticated;


CREATE OR REPLACE FUNCTION public.get_executive_stats(
  _business_id uuid,
  _branch_id   uuid,
  _kind        text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_recv numeric := 0;
  v_pay  numeric := 0;
  v_cash numeric := 0;
  v_customers integer := 0;
  v_employees integer := 0;
BEGIN
  PERFORM public.assert_can_view_dashboard_scope(_business_id, _branch_id, _kind);
  SELECT organization_id INTO v_org FROM public.businesses WHERE id = _business_id;

  SELECT COALESCE(SUM(i.total - i.amount_paid), 0)
  INTO v_recv
  FROM public.invoices i
  WHERE i.organization_id = v_org AND i.business_id = _business_id
    AND i.status IN ('sent','viewed','partial','overdue','confirmed')
    AND (_kind <> 'branch_only' OR i.branch_id = _branch_id);

  SELECT COALESCE(SUM(b.total - b.amount_paid), 0)
  INTO v_pay
  FROM public.bills b
  WHERE b.organization_id = v_org AND b.business_id = _business_id
    AND b.status IN ('open','partial','overdue','approved','received')
    AND (_kind <> 'branch_only' OR b.branch_id = _branch_id);

  -- Cash position from posted JE on real cash/bank detail_types.
  -- Fix: the previous list ('bank','cash') doesn't exist in the COA enum.
  SELECT COALESCE(SUM(jel.debit - jel.credit), 0)
  INTO v_cash
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.accounts a ON a.id = jel.account_id
  WHERE je.organization_id = v_org AND je.business_id = _business_id
    AND je.status = 'posted'
    AND a.account_type = 'asset'
    AND a.detail_type IN (
      'cash_on_hand','checking','savings','money_market','undeposited_funds'
    )
    AND (_kind <> 'branch_only' OR jel.branch_id = _branch_id);

  IF _kind = 'branch_only' THEN
    SELECT COUNT(DISTINCT i.contact_id)
    INTO v_customers
    FROM public.invoices i
    WHERE i.organization_id = v_org AND i.business_id = _business_id
      AND i.branch_id = _branch_id AND i.contact_id IS NOT NULL;
  ELSE
    SELECT COUNT(*)::int INTO v_customers
    FROM public.contacts c
    WHERE c.organization_id = v_org AND c.business_id = _business_id
      AND c.contact_type IN ('customer','both');
  END IF;

  BEGIN
    EXECUTE 'SELECT COUNT(*) FROM public.employees WHERE business_id = $1'
      INTO v_employees USING _business_id;
  EXCEPTION WHEN undefined_table THEN
    v_employees := 0;
  END;

  RETURN jsonb_build_object(
    'scope_kind',     _kind,
    'business_id',    _business_id,
    'branch_id',      _branch_id,
    'receivables',    v_recv,
    'payables',       v_pay,
    'cash_position',  v_cash,
    'customer_count', v_customers,
    'employee_count', v_employees,
    'employee_scope', 'business'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_executive_stats(uuid, uuid, text) TO authenticated;

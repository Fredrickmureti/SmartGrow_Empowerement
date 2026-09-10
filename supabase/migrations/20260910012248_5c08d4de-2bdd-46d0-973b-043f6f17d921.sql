CREATE OR REPLACE FUNCTION public.get_executive_stats(_business_id uuid, _branch_id uuid, _kind text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid;
  v_recv numeric := 0;
  v_cash numeric := 0;
  v_clients integer := 0;
  v_employees integer := 0;
BEGIN
  PERFORM public.assert_can_view_dashboard_scope(_business_id, _branch_id, _kind);
  SELECT organization_id INTO v_org FROM public.businesses WHERE id = _business_id;

  -- Receivable = portfolio still owed by borrowers.
  SELECT COALESCE(SUM(b.total_outstanding), 0)
  INTO v_recv
  FROM public.mf_loan_balances b
  WHERE b.business_id = _business_id
    AND (_kind <> 'branch_only' OR b.branch_id = _branch_id);

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

  SELECT COUNT(*)::int INTO v_clients
  FROM public.mf_clients c
  WHERE c.business_id = _business_id
    AND (_kind <> 'branch_only' OR c.branch_id = _branch_id);

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
    'payables',       0,
    'cash_position',  v_cash,
    'customer_count', v_clients,
    'employee_count', v_employees,
    'employee_scope', 'business'
  );
END;
$function$;
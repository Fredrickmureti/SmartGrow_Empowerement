CREATE OR REPLACE FUNCTION public.get_equity_result(
  _org_id uuid,
  _business_id uuid,
  _as_of date,
  _branch_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(
  fiscal_year_start date,
  current_year_earnings numeric,
  prior_years_result numeric,
  retained_earnings_account_id uuid
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_fy_month int;
  v_fy_start date;
  v_re_account uuid;
  v_current numeric := 0;
  v_prior numeric := 0;
BEGIN
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'get_equity_result: _org_id is required';
  END IF;
  IF _as_of IS NULL THEN
    RAISE EXCEPTION 'get_equity_result: _as_of is required';
  END IF;

  IF NOT public.finance_can_read_scope(_org_id, _business_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  IF _business_id IS NOT NULL THEN
    PERFORM 1 FROM public.businesses b
      WHERE b.id = _business_id AND b.organization_id = _org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'get_equity_result: business % does not belong to org %', _business_id, _org_id;
    END IF;
  END IF;

  IF _branch_id IS NOT NULL THEN
    PERFORM 1 FROM public.branches br
      WHERE br.id = _branch_id
        AND br.organization_id = _org_id
        AND (_business_id IS NULL OR br.business_id = _business_id);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'get_equity_result: branch % does not belong to org % / business %', _branch_id, _org_id, _business_id;
    END IF;
  END IF;

  -- Same fiscal-calendar rule as get_ledger_opening_balances.
  SELECT COALESCE(b.fiscal_year_start, 1) INTO v_fy_month
    FROM public.businesses b
   WHERE b.id = _business_id;
  v_fy_month := COALESCE(v_fy_month, 1);
  IF v_fy_month < 1 OR v_fy_month > 12 THEN
    v_fy_month := 1;
  END IF;

  v_fy_start := make_date(EXTRACT(YEAR FROM _as_of)::int, v_fy_month, 1);
  IF v_fy_start > _as_of THEN
    v_fy_start := v_fy_start - INTERVAL '1 year';
  END IF;

  SELECT das.account_id INTO v_re_account
    FROM public.default_account_settings das
   WHERE das.organization_id = _org_id
     AND das.setting_key = 'retained_earnings'
     AND (_business_id IS NULL OR das.business_id = _business_id OR das.business_id IS NULL)
   ORDER BY (das.business_id IS NOT NULL) DESC
   LIMIT 1;

  IF v_re_account IS NULL THEN
    SELECT a.id INTO v_re_account
      FROM public.accounts a
     WHERE a.organization_id = _org_id
       AND (_business_id IS NULL OR a.business_id = _business_id)
       AND a.account_type = 'equity'
       AND a.detail_type = 'retained_earnings'
     ORDER BY a.code
     LIMIT 1;
  END IF;

  SELECT
    COALESCE(SUM(jel.credit - jel.debit) FILTER (WHERE je.entry_date >= v_fy_start), 0),
    COALESCE(SUM(jel.credit - jel.debit) FILTER (WHERE je.entry_date <  v_fy_start), 0)
    INTO v_current, v_prior
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.accounts a ON a.id = jel.account_id
   WHERE je.organization_id = _org_id
     AND je.status = ANY (public.ledger_visible_journal_statuses())
     AND je.entry_date <= _as_of
     AND (_business_id IS NULL OR je.business_id = _business_id)
     AND (_branch_id IS NULL OR je.branch_id = _branch_id)
     AND a.account_type IN ('income', 'expense');

  RETURN QUERY SELECT v_fy_start, v_current, v_prior, v_re_account;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_equity_result(uuid, uuid, date, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_equity_result(uuid, uuid, date, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_equity_result(uuid, uuid, date, uuid) TO authenticated, service_role;
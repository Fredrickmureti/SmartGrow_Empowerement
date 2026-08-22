CREATE OR REPLACE FUNCTION public.get_ledger_opening_balances(
  _org_id uuid,
  _business_id uuid,
  _as_of date,
  _branch_id uuid DEFAULT NULL
)
RETURNS TABLE (
  account_id uuid,
  opening_balance numeric,
  fiscal_year_start date,
  is_nominal boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_fy_month int;
  v_fy_start date;
  v_opening_end date;
  v_prior_result numeric := 0;
  v_re_account uuid;
BEGIN
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'get_ledger_opening_balances: _org_id is required';
  END IF;
  IF _as_of IS NULL THEN
    RAISE EXCEPTION 'get_ledger_opening_balances: _as_of is required';
  END IF;

  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  IF _business_id IS NOT NULL THEN
    PERFORM 1 FROM public.businesses b
      WHERE b.id = _business_id AND b.organization_id = _org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'get_ledger_opening_balances: business % does not belong to org %', _business_id, _org_id;
    END IF;
  END IF;

  IF _branch_id IS NOT NULL THEN
    PERFORM 1 FROM public.branches br
      WHERE br.id = _branch_id
        AND br.organization_id = _org_id
        AND (_business_id IS NULL OR br.business_id = _business_id);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'get_ledger_opening_balances: branch % does not belong to org % / business %', _branch_id, _org_id, _business_id;
    END IF;
  END IF;

  -- Fiscal year start month; NULL means a calendar year.
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
  v_opening_end := _as_of - 1;

  -- Retained earnings target: explicit default account setting first, then a
  -- retained_earnings detail_type account, lowest code wins.
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

  -- Net result of every fiscal year that closed before this one. Real
  -- year-end closing entries (if any exist) net this to zero on their own,
  -- so this never double-counts a closed year.
  SELECT COALESCE(SUM(jel.credit - jel.debit), 0)
    INTO v_prior_result
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.accounts a ON a.id = jel.account_id
   WHERE je.organization_id = _org_id
     AND je.status = ANY (public.ledger_visible_journal_statuses())
     AND je.entry_date < v_fy_start
     AND (_business_id IS NULL OR je.business_id = _business_id)
     AND (_branch_id IS NULL OR je.branch_id = _branch_id)
     AND a.account_type IN ('income', 'expense');

  RETURN QUERY
  WITH scoped_accounts AS (
    SELECT a.id, a.account_type, a.opening_balance
      FROM public.accounts a
     WHERE a.organization_id = _org_id
       AND (_business_id IS NULL OR a.business_id = _business_id)
  ),
  movement AS (
    SELECT
      jel.account_id AS acct,
      COALESCE(SUM(jel.debit), 0)  AS dr,
      COALESCE(SUM(jel.credit), 0) AS cr,
      COALESCE(SUM(jel.debit)  FILTER (WHERE je.entry_date >= v_fy_start), 0) AS fy_dr,
      COALESCE(SUM(jel.credit) FILTER (WHERE je.entry_date >= v_fy_start), 0) AS fy_cr
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
   WHERE je.organization_id = _org_id
     AND je.status = ANY (public.ledger_visible_journal_statuses())
     AND je.entry_date <= v_opening_end
     AND (_business_id IS NULL OR je.business_id = _business_id)
     AND (_branch_id IS NULL OR je.branch_id = _branch_id)
   GROUP BY jel.account_id
  )
  SELECT
    sa.id,
    (
      CASE
        -- Nominal accounts restart at the fiscal year boundary.
        WHEN sa.account_type IN ('income', 'expense')
          THEN COALESCE(m.fy_cr, 0) - COALESCE(m.fy_dr, 0)
        -- Balance sheet, debit-normal.
        WHEN sa.account_type = 'asset'
          THEN (CASE WHEN _branch_id IS NULL THEN COALESCE(sa.opening_balance, 0) ELSE 0 END)
               + COALESCE(m.dr, 0) - COALESCE(m.cr, 0)
        -- Balance sheet, credit-normal.
        ELSE (CASE WHEN _branch_id IS NULL THEN COALESCE(sa.opening_balance, 0) ELSE 0 END)
             + COALESCE(m.cr, 0) - COALESCE(m.dr, 0)
      END
      -- Prior fiscal years' result lands in retained earnings so the opening
      -- columns of a trial balance still balance after the nominal reset.
      + CASE WHEN v_re_account IS NOT NULL AND sa.id = v_re_account THEN v_prior_result ELSE 0 END
    )::numeric,
    v_fy_start,
    sa.account_type IN ('income', 'expense')
  FROM scoped_accounts sa
  LEFT JOIN movement m ON m.acct = sa.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_ledger_opening_balances(uuid, uuid, date, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_ledger_opening_balances(uuid, uuid, date, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_ledger_opening_balances(uuid, uuid, date, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_ledger_opening_balances(uuid, uuid, date, uuid) IS
'Fiscal-year-aware opening position per account, in base currency. Nominal (income/expense) accounts reset at the fiscal year start; balance-sheet accounts carry since inception. Prior fiscal years net result is folded into retained earnings so opening debits still equal opening credits. Branch-scoped runs exclude accounts.opening_balance (a business-level property).';
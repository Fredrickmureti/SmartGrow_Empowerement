CREATE OR REPLACE FUNCTION public.branch_day_expected_cash(p_day_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  d          record;
  v_cash_acc uuid;
  v_movement numeric := 0;
BEGIN
  SELECT * INTO d FROM public.branch_operational_days WHERE id = p_day_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Branch day % not found', p_day_id; END IF;

  IF NOT public.user_has_business_access(auth.uid(), d.business_id) THEN
    RAISE EXCEPTION 'You do not have access to this branch day';
  END IF;

  v_cash_acc := public.mf_resolve_account(d.business_id, d.branch_id, 'cash');

  -- A reversal keeps the original entry (marked `reversed`) and adds its
  -- mirror; both must be counted so they net to zero. `posted` alone dropped
  -- the original and kept the mirror.
  SELECT COALESCE(SUM(l.debit - l.credit), 0) INTO v_movement
  FROM public.journal_entry_lines l
  JOIN public.journal_entries je ON je.id = l.journal_entry_id
  WHERE l.account_id = v_cash_acc
    AND je.branch_id = d.branch_id
    AND je.entry_date = d.business_date
    AND je.status = ANY (public.ledger_visible_journal_statuses());

  RETURN ROUND(d.opening_cash + v_movement, 2);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_account_movements(_org_id uuid, _date_from date DEFAULT '1900-01-01'::date, _date_to date DEFAULT '2099-12-31'::date)
 RETURNS TABLE(account_id uuid, total_debit numeric, total_credit numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jel.account_id,
         COALESCE(SUM(jel.debit), 0) AS total_debit,
         COALESCE(SUM(jel.credit), 0) AS total_credit
  FROM journal_entry_lines jel
  JOIN journal_entries je ON je.id = jel.journal_entry_id
  WHERE je.organization_id = _org_id
    AND je.status = ANY (public.ledger_visible_journal_statuses())
    AND je.entry_date >= _date_from
    AND je.entry_date <= _date_to
  GROUP BY jel.account_id;
$function$;

CREATE OR REPLACE FUNCTION public.get_account_movements(_org_id uuid, _date_from date, _date_to date, _business_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(account_id uuid, total_debit numeric, total_credit numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'get_account_movements: _org_id is required';
  END IF;

  IF _business_id IS NOT NULL THEN
    PERFORM 1
      FROM public.businesses b
      WHERE b.id = _business_id AND b.organization_id = _org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'get_account_movements: business % does not belong to org %', _business_id, _org_id;
    END IF;
  END IF;

  RETURN QUERY
  SELECT
    jel.account_id,
    COALESCE(SUM(jel.debit), 0)::numeric  AS total_debit,
    COALESCE(SUM(jel.credit), 0)::numeric AS total_credit
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE je.organization_id = _org_id
    AND je.status = ANY (public.ledger_visible_journal_statuses())
    AND je.entry_date BETWEEN _date_from AND _date_to
    AND (_business_id IS NULL OR je.business_id = _business_id)
  GROUP BY jel.account_id;
END;
$function$;
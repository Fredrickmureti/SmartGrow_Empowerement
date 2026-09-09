CREATE OR REPLACE FUNCTION public.branch_day_expected_cash(p_day_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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

  SELECT COALESCE(SUM(l.debit - l.credit), 0) INTO v_movement
  FROM public.journal_entry_lines l
  JOIN public.journal_entries je ON je.id = l.journal_entry_id
  WHERE l.account_id = v_cash_acc
    AND je.branch_id = d.branch_id
    AND je.entry_date = d.business_date
    AND je.status = 'posted';

  RETURN ROUND(d.opening_cash + v_movement, 2);
END;
$$;

REVOKE ALL ON FUNCTION public.branch_day_expected_cash(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.branch_day_expected_cash(uuid) TO authenticated;
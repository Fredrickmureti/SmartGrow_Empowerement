CREATE OR REPLACE FUNCTION public.branch_day_cash_report(
  p_branch_id uuid,
  p_from date,
  p_to date
)
RETURNS TABLE (
  day_id uuid,
  business_date date,
  status text,
  opening_cash numeric,
  cash_in numeric,
  cash_out numeric,
  expected_cash numeric,
  counted_cash numeric,
  variance numeric,
  variance_reason text,
  opened_by uuid,
  closed_by uuid,
  closed_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id uuid;
  v_cash_acc    uuid;
BEGIN
  SELECT b.business_id INTO v_business_id FROM public.branches b WHERE b.id = p_branch_id;
  IF v_business_id IS NULL THEN
    RAISE EXCEPTION 'Branch % not found', p_branch_id;
  END IF;

  IF NOT public.user_has_business_access(auth.uid(), v_business_id) THEN
    RAISE EXCEPTION 'You do not have access to this branch';
  END IF;

  v_cash_acc := public.mf_resolve_account(v_business_id, p_branch_id, 'cash');

  RETURN QUERY
  SELECT
    d.id,
    d.business_date,
    d.status,
    ROUND(COALESCE(d.opening_cash, 0), 2),
    ROUND(COALESCE(m.debits, 0), 2),
    ROUND(COALESCE(m.credits, 0), 2),
    ROUND(COALESCE(d.opening_cash, 0) + COALESCE(m.debits, 0) - COALESCE(m.credits, 0), 2),
    d.counted_cash,
    d.variance,
    d.variance_reason,
    d.opened_by,
    d.closed_by,
    d.closed_at
  FROM public.branch_operational_days d
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(l.debit), 0) AS debits,
           COALESCE(SUM(l.credit), 0) AS credits
    FROM public.journal_entry_lines l
    JOIN public.journal_entries je ON je.id = l.journal_entry_id
    WHERE l.account_id = v_cash_acc
      AND je.branch_id = d.branch_id
      AND je.entry_date = d.business_date
      AND je.status = 'posted'
  ) m ON TRUE
  WHERE d.branch_id = p_branch_id
    AND d.business_date >= p_from
    AND d.business_date <= p_to
  ORDER BY d.business_date DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.branch_day_cash_report(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.branch_day_cash_report(uuid, date, date) TO authenticated;
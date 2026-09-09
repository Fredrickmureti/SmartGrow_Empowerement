CREATE OR REPLACE FUNCTION public.reopen_fiscal_period(_period_id uuid)
RETURNS public.fiscal_periods
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_period public.fiscal_periods;
  v_uid    uuid := auth.uid();
BEGIN
  SELECT * INTO v_period FROM public.fiscal_periods WHERE id = _period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fiscal period not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.has_finance_permission(v_uid, 'finance.manage_periods', v_period.business_id) THEN
    RAISE EXCEPTION 'You do not have permission to reopen fiscal periods for this business'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.fiscal_periods
     SET status     = 'open',
         is_closed  = false,
         closed_at  = NULL,
         locked_at  = NULL,
         locked_by  = NULL
   WHERE id = _period_id
   RETURNING * INTO v_period;

  RETURN v_period;
END;
$$;
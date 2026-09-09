CREATE OR REPLACE FUNCTION public.close_fiscal_period(_period_id uuid, _notes text DEFAULT NULL::text)
RETURNS public.fiscal_periods
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_period public.fiscal_periods;
  v_uid    uuid := auth.uid();
  v_readiness jsonb;
BEGIN
  SELECT * INTO v_period FROM public.fiscal_periods WHERE id = _period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fiscal period not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.has_finance_permission(v_uid, 'finance.manage_periods', v_period.business_id) THEN
    RAISE EXCEPTION 'You do not have permission to close fiscal periods for this business'
      USING ERRCODE = '42501';
  END IF;

  -- ADR 0136: a period cannot close with unvalued foreign monetary balances.
  v_readiness := public.fx_revaluation_readiness(v_period.business_id, v_period.end_date);
  IF COALESCE((v_readiness->>'needs_revaluation')::boolean, false) THEN
    RAISE EXCEPTION 'Period % has foreign-currency balances that have not been revalued. Run FX revaluation as of % first.',
      v_period.name, v_period.end_date
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.fiscal_periods
     SET status     = 'closed',
         is_closed  = true,
         closed_at  = now(),
         locked_at  = now(),
         locked_by  = v_uid,
         notes      = COALESCE(_notes, notes)
   WHERE id = _period_id
   RETURNING * INTO v_period;

  RETURN v_period;
END;
$$;
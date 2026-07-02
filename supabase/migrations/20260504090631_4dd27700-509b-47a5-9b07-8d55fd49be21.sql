
-- ============================================================
-- Wave 5 / Step 1: Server-side fiscal period locking enforcement
-- ============================================================

-- 1. Attach the existing assert function as a trigger so any direct
--    INSERT / UPDATE / DELETE on fiscal_periods from a branch-scoped
--    session is blocked. (The function already does the right thing;
--    Wave 4 forgot to actually attach it.)
DROP TRIGGER IF EXISTS trg_fiscal_periods_no_branch_context ON public.fiscal_periods;
CREATE TRIGGER trg_fiscal_periods_no_branch_context
  BEFORE INSERT OR UPDATE OR DELETE ON public.fiscal_periods
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_no_branch_context_for_period_mutation();

-- 2. SECURITY DEFINER RPCs that enforce finance.manage_periods permission.
--    These become the only sanctioned path for closing / reopening periods.
CREATE OR REPLACE FUNCTION public.close_fiscal_period(_period_id uuid, _notes text DEFAULT NULL)
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
    RAISE EXCEPTION 'You do not have permission to close fiscal periods for this business'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.fiscal_periods
     SET status     = 'closed',
         locked_at  = now(),
         locked_by  = v_uid,
         notes      = COALESCE(_notes, notes)
   WHERE id = _period_id
   RETURNING * INTO v_period;

  RETURN v_period;
END;
$$;

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
         locked_at  = NULL,
         locked_by  = NULL
   WHERE id = _period_id
   RETURNING * INTO v_period;

  RETURN v_period;
END;
$$;

GRANT EXECUTE ON FUNCTION public.close_fiscal_period(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reopen_fiscal_period(uuid) TO authenticated;

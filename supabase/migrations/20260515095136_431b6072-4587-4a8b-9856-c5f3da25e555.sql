-- Update the fiscal-period mutation guard so that the headquarters branch
-- context is allowed (HQ branch IS the parent-business edit surface in the
-- new model). Non-HQ branch contexts remain rejected as a defense-in-depth
-- backstop for the UI gate in useFinanceScope.isBranchScopedReadOnly.
CREATE OR REPLACE FUNCTION public.assert_no_branch_context_for_period_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_branch text;
  v_is_hq  boolean;
BEGIN
  v_branch := current_setting('app.active_branch_id', true);
  IF v_branch IS NULL OR v_branch = '' OR v_branch = 'null' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Allow when the active branch is the headquarters of its business.
  SELECT COALESCE(is_headquarters, false) INTO v_is_hq
  FROM public.branches
  WHERE id = v_branch::uuid;

  IF COALESCE(v_is_hq, false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  RAISE EXCEPTION
    'Fiscal period changes are managed at the parent business. Switch to the headquarters branch first.'
    USING ERRCODE = '42501';
END;
$$;

CREATE OR REPLACE FUNCTION public._budget_assert_read(_budget_id uuid)
 RETURNS budgets
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  b public.budgets;
BEGIN
  SELECT * INTO b FROM public.budgets WHERE id = _budget_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Budget not found' USING ERRCODE = 'P0002';
  END IF;

  -- Trusted server code (scheduled reports, render-report) runs as
  -- service_role with no end user. It already has unrestricted access to
  -- these tables, and its own caller gate runs before it gets here, so
  -- refusing it the RPC would only push it back onto a hand-rolled query —
  -- which is exactly the divergence this function exists to prevent.
  IF current_user = 'service_role' OR current_setting('role', true) = 'service_role' THEN
    RETURN b;
  END IF;

  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_can_access_business(auth.uid(), b.business_id)
     OR NOT public.user_has_module_permission(auth.uid(), b.organization_id, b.business_id, 'financials', 'read') THEN
    RAISE EXCEPTION 'You do not have permission to view budgets for this business'
      USING ERRCODE = '42501';
  END IF;

  IF b.branch_id IS NOT NULL
     AND NOT public.user_can_access_branch(auth.uid(), b.branch_id)
     AND NOT public.has_finance_permission(auth.uid(), 'finance.view_consolidated', b.business_id) THEN
    RAISE EXCEPTION 'You do not have permission to view budgets for this branch'
      USING ERRCODE = '42501';
  END IF;

  RETURN b;
END;
$function$;
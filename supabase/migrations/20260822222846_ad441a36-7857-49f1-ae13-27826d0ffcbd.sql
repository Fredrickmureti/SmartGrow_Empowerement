CREATE OR REPLACE FUNCTION public.get_period_budget_variance(_fiscal_period_id uuid)
RETURNS TABLE(
  budget_id uuid,
  account_id uuid,
  account_code text,
  account_name text,
  account_type text,
  budgeted_amount numeric,
  actual_amount numeric,
  variance_amount numeric,
  variance_percent numeric,
  is_favourable boolean,
  is_unbudgeted boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _period public.fiscal_periods;
  _budget_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _period FROM public.fiscal_periods WHERE id = _fiscal_period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fiscal period not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.user_can_access_business(auth.uid(), _period.business_id)
     OR NOT public.user_has_module_permission(auth.uid(), _period.organization_id, _period.business_id, 'financials', 'read') THEN
    RAISE EXCEPTION 'You do not have permission to view budgets for this business'
      USING ERRCODE = '42501';
  END IF;

  -- The company-wide active budget whose fiscal year contains this period.
  SELECT b.id INTO _budget_id
  FROM public.budgets b
  WHERE b.business_id = _period.business_id
    AND b.status = 'active'
    AND b.branch_id IS NULL
    AND EXISTS (
      SELECT 1 FROM public.budget_fiscal_months(b.business_id, b.fiscal_year) m
      WHERE m.period_id = _fiscal_period_id
    )
  ORDER BY b.created_at DESC
  LIMIT 1;

  IF _budget_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT _budget_id,
         r.account_id,
         r.account_code,
         r.account_name,
         r.account_type,
         r.budgeted_amount,
         r.actual_amount,
         r.variance_amount,
         r.variance_percent,
         r.is_favourable,
         r.is_unbudgeted
  FROM public.get_budget_variance_report(_budget_id) r
  WHERE r.fiscal_period_id = _fiscal_period_id
  ORDER BY r.account_code;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_period_budget_variance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_period_budget_variance(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_period_budget_variance(uuid) TO service_role;
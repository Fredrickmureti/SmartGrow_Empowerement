
CREATE OR REPLACE FUNCTION public.assert_can_manage_periods(_business_id uuid)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF _business_id IS NULL THEN
    RAISE EXCEPTION 'Business context required to manage Fiscal Periods'
      USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_finance_permission(auth.uid(), 'finance.manage_periods', _business_id) THEN
    RAISE EXCEPTION 'INSUFFICIENT_PRIVILEGE_PERIOD_MANAGE: Fiscal Periods are managed at the business level. The current user lacks finance.manage_periods.'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.assert_can_manage_periods(uuid) TO authenticated;

DROP POLICY IF EXISTS fiscal_periods_insert_per_business ON public.fiscal_periods;
DROP POLICY IF EXISTS fiscal_periods_update_per_business ON public.fiscal_periods;
DROP POLICY IF EXISTS fiscal_periods_delete_per_business ON public.fiscal_periods;

CREATE POLICY fiscal_periods_insert_perm_v2
ON public.fiscal_periods
FOR INSERT TO authenticated
WITH CHECK (
  public.user_can_access_business(auth.uid(), business_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'create')
  AND public.has_finance_permission(auth.uid(), 'finance.manage_periods', business_id)
);

CREATE POLICY fiscal_periods_update_perm_v2
ON public.fiscal_periods
FOR UPDATE TO authenticated
USING (
  public.user_can_access_business(auth.uid(), business_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'write')
  AND public.has_finance_permission(auth.uid(), 'finance.manage_periods', business_id)
);

CREATE POLICY fiscal_periods_delete_perm_v2
ON public.fiscal_periods
FOR DELETE TO authenticated
USING (
  public.user_can_access_business(auth.uid(), business_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'delete')
  AND public.has_finance_permission(auth.uid(), 'finance.manage_periods', business_id)
);

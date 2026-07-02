
-- 1. Extend has_finance_permission with the new key
CREATE OR REPLACE FUNCTION public.has_finance_permission(_user_id uuid, _perm text, _business_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH ctx AS (
    SELECT
      EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = _user_id
          AND ur.is_active = true
          AND ur.role IN ('super_admin','owner','admin','accountant')
          AND (_business_id IS NULL OR ur.organization_id IN (
            SELECT organization_id FROM public.businesses WHERE id = _business_id
          ))
      ) AS is_acct
  )
  SELECT CASE
    WHEN _perm IN (
      'finance.view_consolidated','finance.manage_je','finance.void_je',
      'finance.reconcile_bank','finance.export_reports',
      'finance.manage_settings','finance.manage_coa','finance.manage_periods',
      'finance.manage_budgets'
    ) THEN (SELECT is_acct FROM ctx)
    ELSE false
  END;
$function$;

-- 2. assert_can_manage_budgets helper
CREATE OR REPLACE FUNCTION public.assert_can_manage_budgets(_business_id uuid)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF _business_id IS NULL THEN
    RAISE EXCEPTION 'Business context required to manage Budgets'
      USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_finance_permission(auth.uid(), 'finance.manage_budgets', _business_id) THEN
    RAISE EXCEPTION 'INSUFFICIENT_PRIVILEGE_BUDGET_MANAGE: Budgets are managed at the business level. The current user lacks finance.manage_budgets.'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.assert_can_manage_budgets(uuid) TO authenticated;

-- 3. Tighten budgets RLS — drop legacy v2, recreate as perm_v3
DROP POLICY IF EXISTS budgets_insert_v2 ON public.budgets;
DROP POLICY IF EXISTS budgets_update_v2 ON public.budgets;
DROP POLICY IF EXISTS budgets_delete_v2 ON public.budgets;

CREATE POLICY budgets_insert_perm_v3
ON public.budgets
FOR INSERT TO authenticated
WITH CHECK (
  public.user_can_access_business(auth.uid(), business_id)
  AND public.has_finance_permission(auth.uid(), 'finance.manage_budgets', business_id)
  AND ((branch_id IS NULL) OR public.user_can_access_branch(auth.uid(), branch_id) OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

CREATE POLICY budgets_update_perm_v3
ON public.budgets
FOR UPDATE TO authenticated
USING (
  public.user_can_access_business(auth.uid(), business_id)
  AND public.has_finance_permission(auth.uid(), 'finance.manage_budgets', business_id)
  AND ((branch_id IS NULL) OR public.user_can_access_branch(auth.uid(), branch_id) OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
)
WITH CHECK (
  public.user_can_access_business(auth.uid(), business_id)
  AND public.has_finance_permission(auth.uid(), 'finance.manage_budgets', business_id)
  AND ((branch_id IS NULL) OR public.user_can_access_branch(auth.uid(), branch_id) OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

CREATE POLICY budgets_delete_perm_v3
ON public.budgets
FOR DELETE TO authenticated
USING (
  public.user_can_access_business(auth.uid(), business_id)
  AND public.has_finance_permission(auth.uid(), 'finance.manage_budgets', business_id)
  AND ((branch_id IS NULL) OR public.user_can_access_branch(auth.uid(), branch_id) OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

-- 4. Tighten budget_items RLS — replace the legacy "Users can …" policies
DROP POLICY IF EXISTS "Users can create budget items" ON public.budget_items;
DROP POLICY IF EXISTS "Users can update budget items" ON public.budget_items;
DROP POLICY IF EXISTS "Users can delete budget items" ON public.budget_items;

CREATE POLICY budget_items_insert_perm_v3
ON public.budget_items
FOR INSERT TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.budgets b
    WHERE b.id = budget_id
      AND public.user_can_access_business(auth.uid(), b.business_id)
      AND public.has_finance_permission(auth.uid(), 'finance.manage_budgets', b.business_id)
  )
);

CREATE POLICY budget_items_update_perm_v3
ON public.budget_items
FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.budgets b
    WHERE b.id = budget_id
      AND public.user_can_access_business(auth.uid(), b.business_id)
      AND public.has_finance_permission(auth.uid(), 'finance.manage_budgets', b.business_id)
  )
);

CREATE POLICY budget_items_delete_perm_v3
ON public.budget_items
FOR DELETE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.budgets b
    WHERE b.id = budget_id
      AND public.user_can_access_business(auth.uid(), b.business_id)
      AND public.has_finance_permission(auth.uid(), 'finance.manage_budgets', b.business_id)
  )
);

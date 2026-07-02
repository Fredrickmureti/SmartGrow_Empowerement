
-- 1. Extend has_finance_permission with finance.manage_assets
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
      'finance.manage_budgets','finance.manage_assets'
    ) THEN (SELECT is_acct FROM ctx)
    ELSE false
  END;
$function$;

-- 2. assert_can_manage_assets helper
CREATE OR REPLACE FUNCTION public.assert_can_manage_assets(_business_id uuid)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF _business_id IS NULL THEN
    RAISE EXCEPTION 'Business context required to manage Fixed Assets'
      USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_finance_permission(auth.uid(), 'finance.manage_assets', _business_id) THEN
    RAISE EXCEPTION 'INSUFFICIENT_PRIVILEGE_ASSET_MANAGE: Fixed assets are managed at the business level. The current user lacks finance.manage_assets.'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.assert_can_manage_assets(uuid) TO authenticated;

-- 3. Backfill depreciation_schedules.business_id from parent asset, then enforce NOT NULL
UPDATE public.depreciation_schedules ds
SET business_id = fa.business_id
FROM public.fixed_assets fa
WHERE ds.asset_id = fa.id
  AND ds.business_id IS DISTINCT FROM fa.business_id;

ALTER TABLE public.depreciation_schedules
  ALTER COLUMN business_id SET NOT NULL;

-- 4. Tighten fixed_assets write RLS — replace *_perm with *_perm_v3 requiring finance.manage_assets
DROP POLICY IF EXISTS fixed_assets_insert_perm ON public.fixed_assets;
DROP POLICY IF EXISTS fixed_assets_update_perm ON public.fixed_assets;
DROP POLICY IF EXISTS fixed_assets_delete_perm ON public.fixed_assets;

CREATE POLICY fixed_assets_insert_perm_v3
ON public.fixed_assets
FOR INSERT TO authenticated
WITH CHECK (
  public.user_can_access_business(auth.uid(), business_id)
  AND public.has_finance_permission(auth.uid(), 'finance.manage_assets', business_id)
  AND ((branch_id IS NULL) OR public.user_can_access_branch(auth.uid(), branch_id) OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

CREATE POLICY fixed_assets_update_perm_v3
ON public.fixed_assets
FOR UPDATE TO authenticated
USING (
  public.user_can_access_business(auth.uid(), business_id)
  AND public.has_finance_permission(auth.uid(), 'finance.manage_assets', business_id)
  AND ((branch_id IS NULL) OR public.user_can_access_branch(auth.uid(), branch_id) OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
)
WITH CHECK (
  public.user_can_access_business(auth.uid(), business_id)
  AND public.has_finance_permission(auth.uid(), 'finance.manage_assets', business_id)
  AND ((branch_id IS NULL) OR public.user_can_access_branch(auth.uid(), branch_id) OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

CREATE POLICY fixed_assets_delete_perm_v3
ON public.fixed_assets
FOR DELETE TO authenticated
USING (
  public.user_can_access_business(auth.uid(), business_id)
  AND public.has_finance_permission(auth.uid(), 'finance.manage_assets', business_id)
  AND ((branch_id IS NULL) OR public.user_can_access_branch(auth.uid(), branch_id) OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

-- 5. Tighten asset_categories write RLS — replace *_v2 with *_perm_v3 requiring finance.manage_assets
DROP POLICY IF EXISTS asset_categories_insert_v2 ON public.asset_categories;
DROP POLICY IF EXISTS asset_categories_update_v2 ON public.asset_categories;
DROP POLICY IF EXISTS asset_categories_delete_v2 ON public.asset_categories;

CREATE POLICY asset_categories_insert_perm_v3
ON public.asset_categories
FOR INSERT TO authenticated
WITH CHECK (
  public.user_can_access_business(auth.uid(), business_id)
  AND public.has_finance_permission(auth.uid(), 'finance.manage_assets', business_id)
);

CREATE POLICY asset_categories_update_perm_v3
ON public.asset_categories
FOR UPDATE TO authenticated
USING (
  public.user_can_access_business(auth.uid(), business_id)
  AND public.has_finance_permission(auth.uid(), 'finance.manage_assets', business_id)
)
WITH CHECK (
  public.user_can_access_business(auth.uid(), business_id)
  AND public.has_finance_permission(auth.uid(), 'finance.manage_assets', business_id)
);

CREATE POLICY asset_categories_delete_perm_v3
ON public.asset_categories
FOR DELETE TO authenticated
USING (
  public.user_can_access_business(auth.uid(), business_id)
  AND public.has_finance_permission(auth.uid(), 'finance.manage_assets', business_id)
);

-- 6. Tighten depreciation_schedules write RLS — was org+role only.
DROP POLICY IF EXISTS depreciation_schedules_insert ON public.depreciation_schedules;
DROP POLICY IF EXISTS depreciation_schedules_update ON public.depreciation_schedules;
DROP POLICY IF EXISTS depreciation_schedules_delete ON public.depreciation_schedules;

CREATE POLICY depreciation_schedules_insert_perm_v3
ON public.depreciation_schedules
FOR INSERT TO authenticated
WITH CHECK (
  public.user_can_access_business(auth.uid(), business_id)
  AND public.has_finance_permission(auth.uid(), 'finance.manage_assets', business_id)
  AND EXISTS (
    SELECT 1 FROM public.fixed_assets fa
    WHERE fa.id = asset_id AND fa.business_id = depreciation_schedules.business_id
  )
);

CREATE POLICY depreciation_schedules_update_perm_v3
ON public.depreciation_schedules
FOR UPDATE TO authenticated
USING (
  public.user_can_access_business(auth.uid(), business_id)
  AND public.has_finance_permission(auth.uid(), 'finance.manage_assets', business_id)
)
WITH CHECK (
  public.user_can_access_business(auth.uid(), business_id)
  AND public.has_finance_permission(auth.uid(), 'finance.manage_assets', business_id)
);

CREATE POLICY depreciation_schedules_delete_perm_v3
ON public.depreciation_schedules
FOR DELETE TO authenticated
USING (
  public.user_can_access_business(auth.uid(), business_id)
  AND public.has_finance_permission(auth.uid(), 'finance.manage_assets', business_id)
);

COMMENT ON FUNCTION public.assert_can_manage_assets(uuid) IS
  'Phase 10 — raises INSUFFICIENT_PRIVILEGE_ASSET_MANAGE when caller lacks finance.manage_assets for the supplied business.';

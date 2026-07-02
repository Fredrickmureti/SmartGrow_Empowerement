-- 1. Expand permission_group_rules with ERP-grade permissions
ALTER TABLE public.permission_group_rules
  ADD COLUMN IF NOT EXISTS can_approve boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_post    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_export  boolean NOT NULL DEFAULT false;

UPDATE public.permission_group_rules
   SET can_approve = true,
       can_post    = true,
       can_export  = true
 WHERE can_write = true OR can_delete = true;

UPDATE public.permission_group_rules
   SET can_export = true
 WHERE can_read = true
   AND can_write = false
   AND can_delete = false
   AND can_export = false;

COMMENT ON COLUMN public.permission_group_rules.can_approve IS
  'Approve workflow items (timesheets, leave, expenses, journal entries, payroll runs).';
COMMENT ON COLUMN public.permission_group_rules.can_post IS
  'Post draft records to ledger/finalize (invoices, journal entries, payroll runs).';
COMMENT ON COLUMN public.permission_group_rules.can_export IS
  'Export records to CSV/PDF/XLSX. Restricted for sensitive modules (payroll, GL).';

-- 2. Timesheets app pricing — unique key is (app_id, currency)
INSERT INTO public.app_pricing_rules
  (app_id, monthly_price, yearly_price, currency, is_per_user, is_addon_only, is_active)
VALUES
  ('timesheets', 10, 100, 'USD', false, true, true)
ON CONFLICT (app_id, currency) DO NOTHING;

-- 3. cheapest_plan_for_app
CREATE OR REPLACE FUNCTION public.cheapest_plan_for_app(p_app_id text)
RETURNS TABLE (
  plan_id uuid,
  plan_name text,
  price_monthly numeric,
  currency text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT psp.id, psp.name, psp.price_monthly, COALESCE(psp.base_currency, 'USD')
    FROM public.platform_subscription_plans psp
    JOIN public.plan_app_access paa ON paa.plan_id = psp.id
   WHERE psp.is_active = true
     AND paa.app_id = p_app_id
     AND paa.is_enabled = true
   ORDER BY psp.price_monthly ASC NULLS LAST
   LIMIT 1;
$$;

COMMENT ON FUNCTION public.cheapest_plan_for_app(text) IS
  'Returns the lowest-priced active plan that includes the given app.';

-- 4. preview_app_set_install — onboarding dep closure
CREATE OR REPLACE FUNCTION public.preview_app_set_install(
  p_app_ids text[],
  p_org_id uuid DEFAULT NULL
)
RETURNS TABLE (
  app_id text,
  is_root boolean,
  is_already_installed boolean,
  is_in_plan boolean,
  pricing_monthly numeric,
  pricing_currency text,
  is_addon_only boolean,
  depth int
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_org_apps text[] := ARRAY[]::text[];
  v_plan_apps text[] := ARRAY[]::text[];
BEGIN
  IF p_org_id IS NOT NULL THEN
    SELECT COALESCE(array_agg(oia.app_id), ARRAY[]::text[]) INTO v_org_apps
      FROM public.organization_installed_apps oia
     WHERE oia.organization_id = p_org_id AND oia.is_active = true;

    SELECT COALESCE(array_agg(paa.app_id), ARRAY[]::text[]) INTO v_plan_apps
      FROM public.organizations o
      JOIN public.plan_app_access paa ON paa.plan_id = o.subscription_plan_id
     WHERE o.id = p_org_id AND paa.is_enabled = true;
  END IF;

  RETURN QUERY
  WITH RECURSIVE closure AS (
    SELECT unnest(p_app_ids) AS app_id, true AS is_root, 0 AS depth
    UNION
    SELECT ad.depends_on_app_id, false, c.depth + 1
      FROM public.app_dependencies ad
      JOIN closure c ON c.app_id = ad.app_id
     WHERE c.depth < 6
  ),
  unique_apps AS (
    SELECT app_id, bool_or(is_root) AS is_root, min(depth) AS depth
      FROM closure
     GROUP BY app_id
  )
  SELECT ua.app_id,
         ua.is_root,
         (ua.app_id = ANY(v_org_apps)) AS is_already_installed,
         (ua.app_id = ANY(v_plan_apps)) AS is_in_plan,
         apr.monthly_price,
         COALESCE(apr.currency, 'USD'),
         COALESCE(apr.is_addon_only, false),
         ua.depth
    FROM unique_apps ua
    LEFT JOIN public.app_pricing_rules apr
           ON apr.app_id = ua.app_id AND apr.is_active = true AND apr.currency = 'USD'
   ORDER BY ua.depth ASC, ua.app_id ASC;
END;
$$;

COMMENT ON FUNCTION public.preview_app_set_install(text[], uuid) IS
  'Returns the transitive dependency closure for a set of app IDs with billing/install metadata.';

GRANT EXECUTE ON FUNCTION public.cheapest_plan_for_app(text) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.preview_app_set_install(text[], uuid) TO authenticated;
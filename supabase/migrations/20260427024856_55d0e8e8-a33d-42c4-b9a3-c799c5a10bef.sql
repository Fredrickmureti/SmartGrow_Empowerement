CREATE OR REPLACE FUNCTION public.compute_org_billing(
  p_org_id uuid,
  p_billing_cycle text DEFAULT 'monthly'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_plan RECORD;
  v_currency text;
  v_plan_price numeric := 0;
  v_user_count int := 0;
  v_addons jsonb := '[]'::jsonb;
  v_addons_total numeric := 0;
  v_total numeric := 0;
  v_cycle text := lower(coalesce(p_billing_cycle, 'monthly'));
BEGIN
  IF p_org_id IS NULL THEN
    RETURN jsonb_build_object('error', 'org_id_required');
  END IF;

  IF v_cycle NOT IN ('monthly', 'yearly') THEN
    v_cycle := 'monthly';
  END IF;

  -- Authorization: caller must belong to the org (or be platform admin).
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = auth.uid()
       AND organization_id = p_org_id
       AND is_active = true
  ) AND NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = auth.uid()
       AND role = 'super_admin'
       AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Unauthorized: caller is not a member of organization %', p_org_id
      USING ERRCODE = '42501';
  END IF;

  -- Load plan + currency
  SELECT psp.id, psp.name, psp.price_monthly, psp.price_yearly,
         psp.price_per_user_monthly, psp.price_per_user_yearly,
         coalesce(psp.currency, psp.base_currency, 'USD') AS currency
    INTO v_plan
    FROM public.organizations o
    LEFT JOIN public.platform_subscription_plans psp ON psp.id = o.subscription_plan_id
   WHERE o.id = p_org_id;

  IF v_plan.id IS NULL THEN
    -- No plan attached: still return the addon-only billing.
    v_currency := 'USD';
  ELSE
    v_currency := v_plan.currency;
    v_plan_price := CASE WHEN v_cycle = 'yearly'
                         THEN coalesce(v_plan.price_yearly, 0)
                         ELSE coalesce(v_plan.price_monthly, 0) END;

    -- Per-user uplift if the plan defines per-user pricing.
    IF (v_cycle = 'monthly' AND coalesce(v_plan.price_per_user_monthly, 0) > 0)
       OR (v_cycle = 'yearly' AND coalesce(v_plan.price_per_user_yearly, 0) > 0) THEN
      SELECT COUNT(DISTINCT user_id) INTO v_user_count
        FROM public.user_roles
       WHERE organization_id = p_org_id AND is_active = true;
      v_plan_price := v_plan_price + (v_user_count * CASE WHEN v_cycle = 'yearly'
                                                          THEN coalesce(v_plan.price_per_user_yearly, 0)
                                                          ELSE coalesce(v_plan.price_per_user_monthly, 0) END);
    END IF;
  END IF;

  -- Add-on apps: installed AND active AND not in plan AND not on free trial.
  WITH installed AS (
    SELECT oia.app_id
      FROM public.organization_installed_apps oia
     WHERE oia.organization_id = p_org_id
       AND coalesce(oia.is_active, true) = true
  ),
  in_plan AS (
    SELECT app_id FROM public.plan_app_access
     WHERE plan_id = v_plan.id AND is_enabled = true
  ),
  on_trial AS (
    SELECT app_id FROM public.app_trial_status
     WHERE organization_id = p_org_id
       AND status = 'active'
       AND expires_at > now()
  ),
  billable AS (
    SELECT i.app_id
      FROM installed i
     WHERE NOT EXISTS (SELECT 1 FROM in_plan p WHERE p.app_id = i.app_id)
       AND NOT EXISTS (SELECT 1 FROM on_trial t WHERE t.app_id = i.app_id)
  ),
  priced AS (
    SELECT b.app_id,
           coalesce(apr.monthly_price, 0) AS monthly_price,
           coalesce(apr.yearly_price, 0)  AS yearly_price,
           coalesce(apr.is_per_user, false) AS is_per_user,
           CASE WHEN v_cycle = 'yearly' THEN coalesce(apr.yearly_price, 0)
                ELSE coalesce(apr.monthly_price, 0) END
             * CASE WHEN coalesce(apr.is_per_user, false)
                    THEN GREATEST(1, (SELECT COUNT(DISTINCT user_id)::int
                                        FROM public.user_roles
                                       WHERE organization_id = p_org_id
                                         AND is_active = true))
                    ELSE 1 END AS line_total
      FROM billable b
      LEFT JOIN public.app_pricing_rules apr
             ON apr.app_id = b.app_id
            AND coalesce(apr.is_active, true) = true
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
            'app_id', app_id,
            'monthly_price', monthly_price,
            'yearly_price', yearly_price,
            'is_per_user', is_per_user,
            'line_total', line_total
         ) ORDER BY app_id), '[]'::jsonb),
         coalesce(SUM(line_total), 0)
    INTO v_addons, v_addons_total
    FROM priced;

  v_total := v_plan_price + v_addons_total;

  RETURN jsonb_build_object(
    'org_id',        p_org_id,
    'plan_id',       v_plan.id,
    'plan_name',     v_plan.name,
    'billing_cycle', v_cycle,
    'currency',      v_currency,
    'user_count',    v_user_count,
    'plan_price',    v_plan_price,
    'addons',        v_addons,
    'addons_total',  v_addons_total,
    'total',         v_total,
    'computed_at',   now()
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.compute_org_billing(uuid, text) TO authenticated;
COMMENT ON FUNCTION public.compute_org_billing(uuid, text) IS
  'Canonical billing math for an organization. Returns plan price + non-trial paid add-ons. UI must use this instead of recomputing prices client-side.';
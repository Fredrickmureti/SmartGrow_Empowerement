-- ============================================================
-- Phase A — Subscription / Entitlement / Dependency hardening
-- Zero-trust audit fixes (D1, D2, D3, A4, A5, A6)
-- Idempotent. Additive. Non-destructive.
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- A6. is_addon_only column
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.app_pricing_rules
  ADD COLUMN IF NOT EXISTS is_addon_only boolean NOT NULL DEFAULT false;

-- Mark the apps that are paid add-ons even when present in plans (Xero/Odoo pattern)
UPDATE public.app_pricing_rules
   SET is_addon_only = true
 WHERE app_id IN ('payroll','pos','attendance','time-off','projects','crm','recruitment')
   AND is_addon_only = false;

-- ─────────────────────────────────────────────────────────────
-- A1. Seed plan_app_access correctly (currently all is_enabled=false)
-- Free      → contacts, sales, purchases, finance, reports, platform
-- Growth    → + inventory, documents, sign, spreadsheets, sms, studio
-- Business  → + pos, crm, projects, employees, time-off, attendance, payroll
-- Enterprise→ + recruitment + everything else
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_free uuid;
  v_growth uuid;
  v_business uuid;
  v_enterprise uuid;

  v_free_apps text[]       := ARRAY['contacts','sales','purchases','finance','reports','platform'];
  v_growth_apps text[]     := ARRAY['contacts','sales','purchases','finance','reports','platform','inventory','documents','sign','spreadsheets','sms','studio'];
  v_business_apps text[]   := ARRAY['contacts','sales','purchases','finance','reports','platform','inventory','documents','sign','spreadsheets','sms','studio','pos','crm','projects','employees','time-off','attendance','payroll'];
  v_enterprise_apps text[] := ARRAY['contacts','sales','purchases','finance','reports','platform','inventory','documents','sign','spreadsheets','sms','studio','pos','crm','projects','employees','time-off','attendance','payroll','recruitment'];

  v_app text;
BEGIN
  SELECT id INTO v_free       FROM public.platform_subscription_plans WHERE name='Free'       LIMIT 1;
  SELECT id INTO v_growth     FROM public.platform_subscription_plans WHERE name='Growth'     LIMIT 1;
  SELECT id INTO v_business   FROM public.platform_subscription_plans WHERE name='Business'   LIMIT 1;
  SELECT id INTO v_enterprise FROM public.platform_subscription_plans WHERE name='Enterprise' LIMIT 1;

  -- Reset every existing row to disabled so the seed is the source of truth
  UPDATE public.plan_app_access SET is_enabled = false;

  -- Free
  IF v_free IS NOT NULL THEN
    FOREACH v_app IN ARRAY v_free_apps LOOP
      INSERT INTO public.plan_app_access (plan_id, app_id, is_enabled) VALUES (v_free, v_app, true)
      ON CONFLICT (plan_id, app_id) DO UPDATE SET is_enabled = true;
    END LOOP;
  END IF;

  -- Growth
  IF v_growth IS NOT NULL THEN
    FOREACH v_app IN ARRAY v_growth_apps LOOP
      INSERT INTO public.plan_app_access (plan_id, app_id, is_enabled) VALUES (v_growth, v_app, true)
      ON CONFLICT (plan_id, app_id) DO UPDATE SET is_enabled = true;
    END LOOP;
  END IF;

  -- Business
  IF v_business IS NOT NULL THEN
    FOREACH v_app IN ARRAY v_business_apps LOOP
      INSERT INTO public.plan_app_access (plan_id, app_id, is_enabled) VALUES (v_business, v_app, true)
      ON CONFLICT (plan_id, app_id) DO UPDATE SET is_enabled = true;
    END LOOP;
  END IF;

  -- Enterprise
  IF v_enterprise IS NOT NULL THEN
    FOREACH v_app IN ARRAY v_enterprise_apps LOOP
      INSERT INTO public.plan_app_access (plan_id, app_id, is_enabled) VALUES (v_enterprise, v_app, true)
      ON CONFLICT (plan_id, app_id) DO UPDATE SET is_enabled = true;
    END LOOP;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- A2/D2. Real Odoo-style app dependencies
-- ─────────────────────────────────────────────────────────────
INSERT INTO public.app_dependencies (app_id, depends_on_app_id) VALUES
  -- Payroll truly needs Time Off (unpaid leave changes payslip) and Finance (GL posting)
  ('payroll',     'time-off'),
  ('payroll',     'finance'),

  -- POS
  ('pos',         'inventory'),
  ('pos',         'sales'),
  ('pos',         'finance'),

  -- Sales / Purchases need Contacts + Finance
  ('sales',       'contacts'),
  ('sales',       'finance'),
  ('purchases',   'contacts'),
  ('purchases',   'finance'),

  -- CRM
  ('crm',         'contacts')
ON CONFLICT (app_id, depends_on_app_id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- D3/A2. assert_entitlement: respect is_enabled flag
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.assert_entitlement(p_org_id uuid, p_app_id text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_plan_id uuid;
  v_in_plan boolean;
  v_trial_active boolean;
  v_overridden boolean;
  v_app_name text;
BEGIN
  -- platform/settings is universally accessible
  IF p_app_id = 'platform' THEN RETURN true; END IF;

  -- 1. Plan inclusion (NOW HONOURS is_enabled — previously ignored)
  SELECT subscription_plan_id INTO v_plan_id FROM public.organizations WHERE id = p_org_id;
  IF v_plan_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.plan_app_access
       WHERE plan_id = v_plan_id
         AND app_id = p_app_id
         AND is_enabled = true
    ) INTO v_in_plan;
    IF v_in_plan THEN RETURN true; END IF;
  END IF;

  -- 2. Active trial
  SELECT EXISTS (
    SELECT 1 FROM public.app_trial_status
     WHERE organization_id = p_org_id
       AND app_id = p_app_id
       AND status = 'active'
       AND expires_at > now()
  ) INTO v_trial_active;
  IF v_trial_active THEN RETURN true; END IF;

  -- 3. Per-tenant override
  SELECT EXISTS (
    SELECT 1 FROM public.org_entitlement_overrides
     WHERE organization_id = p_org_id
       AND override_type = 'app'
       AND key = p_app_id
       AND is_active = true
       AND (expires_at IS NULL OR expires_at > now())
  ) INTO v_overridden;
  IF v_overridden THEN RETURN true; END IF;

  SELECT name INTO v_app_name FROM public.platform_apps WHERE id = p_app_id;
  RAISE EXCEPTION 'ENTITLEMENT_REQUIRED: % is not included in your current plan. Upgrade or start a trial to use it.',
    COALESCE(v_app_name, p_app_id) USING ERRCODE = 'P0001', HINT = 'not_entitled';
END;
$function$;

-- ─────────────────────────────────────────────────────────────
-- A5. install_app: auto-install dependencies transitively
-- A4. uninstall_app: block if any installed app depends on the target
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.install_app(p_org_id uuid, p_app_id text)
RETURNS public.organization_installed_apps
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_result public.organization_installed_apps;
  v_use_per_user boolean := false;
  v_max_apps int;
  v_current_count int;
  v_plan_name text;
  v_already_installed boolean;
  v_business_count int;
  v_dep RECORD;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = auth.uid()
       AND organization_id = p_org_id
       AND role IN ('owner','admin')
       AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Unauthorized: you must be an admin or owner of this organization';
  END IF;

  -- Apps that operate on Company-scoped data must have at least one Company.
  IF p_app_id IN (
    'hr','pos',
    'employees','time-off','attendance','payroll','recruitment',
    'sales','purchases','inventory','finance'
  ) THEN
    SELECT COUNT(*) INTO v_business_count
      FROM public.businesses
     WHERE organization_id = p_org_id AND is_active = true;
    IF v_business_count = 0 THEN
      RAISE EXCEPTION 'SETUP_REQUIRED: % requires at least one active Company. Create a Company first, then install this app.',
        p_app_id USING ERRCODE = 'P0001', HINT = 'no_business';
    END IF;
  END IF;

  -- Per-user-billing app cap (only when feature flag enabled)
  SELECT (setting_value::boolean) INTO v_use_per_user
    FROM public.platform_settings
   WHERE setting_key = 'use_per_user_billing'
   LIMIT 1;
  v_use_per_user := COALESCE(v_use_per_user, false);

  SELECT EXISTS (
    SELECT 1 FROM public.organization_installed_apps
     WHERE organization_id = p_org_id AND app_id = p_app_id AND is_active = true
  ) INTO v_already_installed;

  IF v_use_per_user AND NOT v_already_installed AND p_app_id <> 'platform' THEN
    SELECT psp.max_installed_apps, psp.name INTO v_max_apps, v_plan_name
      FROM public.organizations o
      JOIN public.platform_subscription_plans psp ON psp.id = o.subscription_plan_id
     WHERE o.id = p_org_id;
    IF v_max_apps IS NOT NULL THEN
      SELECT COUNT(*) INTO v_current_count
        FROM public.organization_installed_apps
       WHERE organization_id = p_org_id AND is_active = true AND app_id <> 'platform';
      IF v_current_count >= v_max_apps THEN
        RAISE EXCEPTION 'SETUP_REQUIRED: Your % plan includes % app(s). Upgrade to install more.',
          COALESCE(v_plan_name, 'current'), v_max_apps USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  -- 🆕 Auto-install dependencies first (Odoo `depends:` semantics).
  -- Each dep is checked for entitlement (assert_entitlement raises if not entitled).
  -- Dep installation is idempotent via ON CONFLICT.
  FOR v_dep IN
    WITH RECURSIVE deps AS (
      SELECT depends_on_app_id AS app_id, 1 AS depth
        FROM public.app_dependencies
       WHERE app_id = p_app_id
      UNION
      SELECT ad.depends_on_app_id, d.depth + 1
        FROM public.app_dependencies ad
        JOIN deps d ON d.app_id = ad.app_id
       WHERE d.depth < 6
    )
    SELECT DISTINCT app_id FROM deps ORDER BY app_id
  LOOP
    -- Skip if already installed
    IF NOT EXISTS (
      SELECT 1 FROM public.organization_installed_apps
       WHERE organization_id = p_org_id AND app_id = v_dep.app_id AND is_active = true
    ) THEN
      -- Verify entitlement for the dep too
      PERFORM public.assert_entitlement(p_org_id, v_dep.app_id);
      INSERT INTO public.organization_installed_apps (organization_id, app_id, installed_by, is_active)
      VALUES (p_org_id, v_dep.app_id, auth.uid(), true)
      ON CONFLICT (organization_id, app_id) DO UPDATE SET is_active = true, updated_at = now();
      PERFORM public.seed_app_data(p_org_id, v_dep.app_id);
    END IF;
  END LOOP;

  -- Now install the requested app itself (entitlement check)
  PERFORM public.assert_entitlement(p_org_id, p_app_id);

  INSERT INTO public.organization_installed_apps (organization_id, app_id, installed_by, is_active)
  VALUES (p_org_id, p_app_id, auth.uid(), true)
  ON CONFLICT (organization_id, app_id) DO UPDATE SET is_active = true, updated_at = now()
  RETURNING * INTO v_result;

  PERFORM public.seed_app_data(p_org_id, p_app_id);
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.uninstall_app(p_org_id uuid, p_app_id text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_blockers text[];
BEGIN
  -- Verify caller is admin/owner of the target organization
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = auth.uid()
       AND organization_id = p_org_id
       AND role IN ('owner', 'admin')
       AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Unauthorized: you must be an admin or owner of this organization';
  END IF;

  -- Don't allow uninstalling core apps
  IF p_app_id IN ('finance', 'platform') THEN
    RAISE EXCEPTION 'Cannot uninstall core apps';
  END IF;

  -- 🆕 Block if any installed app depends on the target
  SELECT COALESCE(array_agg(DISTINCT ad.app_id ORDER BY ad.app_id), ARRAY[]::text[])
    INTO v_blockers
    FROM public.app_dependencies ad
    JOIN public.organization_installed_apps oia
      ON oia.app_id = ad.app_id
     AND oia.organization_id = p_org_id
     AND oia.is_active = true
   WHERE ad.depends_on_app_id = p_app_id;

  IF v_blockers IS NOT NULL AND array_length(v_blockers, 1) > 0 THEN
    RAISE EXCEPTION 'DEPENDENCY_BLOCKED: % is required by: %. Uninstall those apps first.',
      p_app_id, array_to_string(v_blockers, ', ')
      USING ERRCODE = 'P0001', HINT = 'reverse_dependency';
  END IF;

  UPDATE public.organization_installed_apps
     SET is_active = false, updated_at = now()
   WHERE organization_id = p_org_id AND app_id = p_app_id;

  RETURN FOUND;
END;
$function$;

-- ─────────────────────────────────────────────────────────────
-- Helper RPC: preview install impact (used by app-lifecycle edge fn)
-- Returns the transitive deps that would be auto-installed and any
-- entitlement gaps that would block install.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.preview_install_impact(p_org_id uuid, p_app_id text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_deps text[];
  v_to_install text[];
  v_missing_entitlements text[];
  v_plan_id uuid;
  v_in_plan boolean;
  v_trial_active boolean;
  v_overridden boolean;
  v_dep text;
BEGIN
  SELECT subscription_plan_id INTO v_plan_id FROM public.organizations WHERE id = p_org_id;

  -- Collect transitive dependencies + the requested app itself
  WITH RECURSIVE deps AS (
    SELECT depends_on_app_id AS app_id, 1 AS depth
      FROM public.app_dependencies
     WHERE app_id = p_app_id
    UNION
    SELECT ad.depends_on_app_id, d.depth + 1
      FROM public.app_dependencies ad
      JOIN deps d ON d.app_id = ad.app_id
     WHERE d.depth < 6
  )
  SELECT COALESCE(array_agg(DISTINCT app_id), ARRAY[]::text[]) INTO v_deps FROM deps;

  v_deps := array_append(v_deps, p_app_id);

  -- Of those, which are NOT yet installed?
  SELECT COALESCE(array_agg(a ORDER BY a), ARRAY[]::text[]) INTO v_to_install
    FROM unnest(v_deps) a
   WHERE NOT EXISTS (
     SELECT 1 FROM public.organization_installed_apps
      WHERE organization_id = p_org_id AND app_id = a AND is_active = true
   );

  -- Of those to install, which are NOT entitled?
  v_missing_entitlements := ARRAY[]::text[];
  FOREACH v_dep IN ARRAY v_to_install LOOP
    IF v_dep = 'platform' THEN CONTINUE; END IF;

    SELECT EXISTS (
      SELECT 1 FROM public.plan_app_access
       WHERE plan_id = v_plan_id AND app_id = v_dep AND is_enabled = true
    ) INTO v_in_plan;

    SELECT EXISTS (
      SELECT 1 FROM public.app_trial_status
       WHERE organization_id = p_org_id AND app_id = v_dep
         AND status = 'active' AND expires_at > now()
    ) INTO v_trial_active;

    SELECT EXISTS (
      SELECT 1 FROM public.org_entitlement_overrides
       WHERE organization_id = p_org_id AND override_type = 'app' AND key = v_dep
         AND is_active = true AND (expires_at IS NULL OR expires_at > now())
    ) INTO v_overridden;

    IF NOT (v_in_plan OR v_trial_active OR v_overridden) THEN
      v_missing_entitlements := array_append(v_missing_entitlements, v_dep);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'app_id',                p_app_id,
    'all_dependencies',      v_deps,
    'will_be_installed',     v_to_install,
    'missing_entitlements',  v_missing_entitlements,
    'can_install',           array_length(v_missing_entitlements, 1) IS NULL
  );
END;
$function$;

-- ─────────────────────────────────────────────────────────────
-- Helper RPC: start_app_trial — creates or reactivates a 14-day trial
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.start_app_trial(
  p_org_id uuid,
  p_app_id text,
  p_days int DEFAULT 14
) RETURNS public.app_trial_status
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_row public.app_trial_status;
  v_existing public.app_trial_status;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = auth.uid() AND organization_id = p_org_id
       AND role IN ('owner','admin') AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  IF p_days <= 0 OR p_days > 90 THEN
    RAISE EXCEPTION 'Invalid trial length (1-90 days)';
  END IF;

  SELECT * INTO v_existing FROM public.app_trial_status
   WHERE organization_id = p_org_id AND app_id = p_app_id;

  IF v_existing.id IS NOT NULL AND v_existing.status = 'converted' THEN
    RAISE EXCEPTION 'TRIAL_ALREADY_USED: % was already trialled and converted.', p_app_id
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.app_trial_status (organization_id, app_id, status, started_at, expires_at)
  VALUES (p_org_id, p_app_id, 'active', now(), now() + (p_days || ' days')::interval)
  ON CONFLICT (organization_id, app_id) DO UPDATE
    SET status = 'active',
        started_at = now(),
        expires_at = now() + (p_days || ' days')::interval,
        updated_at = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.preview_install_impact(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_app_trial(uuid, text, int)   TO authenticated;
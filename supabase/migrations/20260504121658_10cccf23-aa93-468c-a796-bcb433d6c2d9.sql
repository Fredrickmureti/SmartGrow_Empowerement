-- 1. dependency_kind classification on app_dependencies
ALTER TABLE public.app_dependencies
  ADD COLUMN IF NOT EXISTS dependency_kind text NOT NULL DEFAULT 'technical'
    CHECK (dependency_kind IN ('technical','bundled','optional'));

-- 2. is_app_trialable helper — an app is trialable when it has an active pricing rule
CREATE OR REPLACE FUNCTION public.is_app_trialable(p_app_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.app_pricing_rules
     WHERE app_id = p_app_id
       AND is_active = true
  );
$$;

REVOKE ALL ON FUNCTION public.is_app_trialable(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_app_trialable(text) TO authenticated;

-- 3. Trial-days resolver — uses platform-wide default_trial_days setting
CREATE OR REPLACE FUNCTION public.resolve_trial_days(p_app_id text)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_default integer;
BEGIN
  SELECT NULLIF(setting_value, '')::integer INTO v_default
    FROM public.platform_settings
   WHERE setting_key = 'default_trial_days'
   LIMIT 1;

  RETURN COALESCE(v_default, 14);
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_trial_days(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_trial_days(text) TO authenticated;

-- 4. resolve_install_plan: dependency-aware classification
CREATE OR REPLACE FUNCTION public.resolve_install_plan(p_org_id uuid, p_app_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan_id uuid;
  v_entries jsonb := '[]'::jsonb;
  v_blocked text[] := ARRAY[]::text[];
  v_will_install text[] := ARRAY[]::text[];
  v_will_trial text[] := ARRAY[]::text[];
  r RECORD;
  v_in_plan boolean;
  v_overridden boolean;
  v_on_trial boolean;
  v_trialable boolean;
  v_already boolean;
  v_action text;
  v_state text;
  v_trial_days integer;
BEGIN
  SELECT subscription_plan_id INTO v_plan_id FROM public.organizations WHERE id = p_org_id;

  FOR r IN
    WITH RECURSIVE deps AS (
      SELECT depends_on_app_id AS app_id,
             dependency_kind,
             1 AS depth
        FROM public.app_dependencies
       WHERE app_id = p_app_id
      UNION
      SELECT ad.depends_on_app_id,
             ad.dependency_kind,
             d.depth + 1
        FROM public.app_dependencies ad
        JOIN deps d ON d.app_id = ad.app_id
       WHERE d.depth < 6
    ),
    collapsed AS (
      SELECT app_id,
             CASE
               WHEN bool_or(dependency_kind = 'bundled') THEN 'bundled'
               WHEN bool_or(dependency_kind = 'technical') THEN 'technical'
               ELSE 'optional'
             END AS dependency_kind,
             MAX(depth) AS depth
        FROM deps
       GROUP BY app_id
    )
    SELECT app_id, dependency_kind, depth FROM collapsed
    UNION ALL
    SELECT p_app_id, 'self'::text, 0
    ORDER BY depth DESC
  LOOP
    IF r.app_id = 'platform' THEN CONTINUE; END IF;

    SELECT EXISTS (
      SELECT 1 FROM public.organization_installed_apps
       WHERE organization_id = p_org_id AND app_id = r.app_id AND is_active = true
    ) INTO v_already;

    SELECT EXISTS (
      SELECT 1 FROM public.plan_app_access
       WHERE plan_id = v_plan_id AND app_id = r.app_id AND is_enabled = true
    ) INTO v_in_plan;

    SELECT EXISTS (
      SELECT 1 FROM public.org_entitlement_overrides
       WHERE organization_id = p_org_id AND override_type = 'app' AND key = r.app_id
         AND is_active = true AND (expires_at IS NULL OR expires_at > now())
    ) INTO v_overridden;

    SELECT EXISTS (
      SELECT 1 FROM public.app_trial_status
       WHERE organization_id = p_org_id AND app_id = r.app_id
         AND status = 'active' AND expires_at > now()
    ) INTO v_on_trial;

    v_trialable := public.is_app_trialable(r.app_id);
    v_trial_days := NULL;

    IF v_already THEN
      v_action := 'already_installed'; v_state := NULL;
    ELSIF v_in_plan THEN
      v_action := 'install_in_plan';   v_state := 'active';
    ELSIF v_overridden THEN
      v_action := 'install_override';  v_state := 'active';
    ELSIF v_on_trial THEN
      v_action := 'install_existing_trial'; v_state := 'trial';
    ELSIF r.dependency_kind = 'bundled' THEN
      v_action := 'install_bundled';   v_state := 'active';
    ELSIF r.dependency_kind = 'optional' THEN
      v_action := 'skip_optional';     v_state := NULL;
    ELSIF v_trialable THEN
      IF EXISTS (
        SELECT 1 FROM public.app_trial_status
         WHERE organization_id = p_org_id AND app_id = r.app_id
           AND status IN ('converted','expired','cancelled')
      ) THEN
        v_action := 'blocked'; v_state := NULL;
        v_blocked := array_append(v_blocked, r.app_id);
      ELSE
        v_action := 'install_will_start_trial'; v_state := 'trial';
        v_trial_days := public.resolve_trial_days(r.app_id);
        v_will_trial := array_append(v_will_trial, r.app_id);
      END IF;
    ELSE
      v_action := 'blocked'; v_state := NULL;
      v_blocked := array_append(v_blocked, r.app_id);
    END IF;

    IF v_action LIKE 'install_%' THEN
      v_will_install := array_append(v_will_install, r.app_id);
    END IF;

    v_entries := v_entries || jsonb_build_object(
      'app_id',          r.app_id,
      'dependency_kind', r.dependency_kind,
      'depth',           r.depth,
      'action',          v_action,
      'lifecycle_state', v_state,
      'trial_days',      v_trial_days,
      'in_plan',         v_in_plan,
      'overridden',      v_overridden,
      'on_trial',        v_on_trial,
      'trialable',       v_trialable,
      'already_installed', v_already
    );
  END LOOP;

  RETURN jsonb_build_object(
    'app_id',                p_app_id,
    'entries',               v_entries,
    'will_install',          v_will_install,
    'will_start_trial',      v_will_trial,
    'blocked_apps',          v_blocked,
    'can_install',           array_length(v_blocked, 1) IS NULL,
    'all_dependencies',      (SELECT COALESCE(array_agg(value->>'app_id'), ARRAY[]::text[])
                               FROM jsonb_array_elements(v_entries)),
    'will_be_installed',     v_will_install,
    'missing_entitlements',  v_blocked
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_install_plan(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_install_plan(uuid, text) TO authenticated;

-- 5. preview_install_impact delegates to resolve_install_plan
CREATE OR REPLACE FUNCTION public.preview_install_impact(p_org_id uuid, p_app_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.resolve_install_plan(p_org_id, p_app_id);
$$;

REVOKE ALL ON FUNCTION public.preview_install_impact(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_install_impact(uuid, text) TO authenticated;

-- 6. Rewrite install_app to consume the plan
CREATE OR REPLACE FUNCTION public.install_app(p_org_id uuid, p_app_id text)
RETURNS organization_installed_apps
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_result public.organization_installed_apps;
  v_use_per_user boolean := false;
  v_max_apps int;
  v_current_count int;
  v_plan_name text;
  v_already_installed boolean;
  v_business_count int;
  v_plan jsonb;
  v_entry jsonb;
  v_blocked text[];
  v_blocked_names text;
  v_plan_id uuid;
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

  v_plan := public.resolve_install_plan(p_org_id, p_app_id);

  v_blocked := ARRAY(SELECT jsonb_array_elements_text(v_plan->'blocked_apps'));

  IF array_length(v_blocked, 1) IS NOT NULL THEN
    SELECT string_agg(COALESCE(pa.name, b), ', ')
      INTO v_blocked_names
      FROM unnest(v_blocked) b
      LEFT JOIN public.platform_apps pa ON pa.id = b;
    RAISE EXCEPTION
      'ENTITLEMENT_REQUIRED: The following app(s) are not included in your plan and cannot be trialled: %. Upgrade your plan to install %.',
      v_blocked_names, COALESCE((SELECT name FROM public.platform_apps WHERE id = p_app_id), p_app_id)
      USING ERRCODE = 'P0001', HINT = 'not_entitled';
  END IF;

  SELECT subscription_plan_id INTO v_plan_id FROM public.organizations WHERE id = p_org_id;

  FOR v_entry IN SELECT jsonb_array_elements(v_plan->'entries')
  LOOP
    IF v_entry->>'action' IN ('already_installed','skip_optional') THEN CONTINUE; END IF;

    IF v_entry->>'action' = 'install_will_start_trial' THEN
      PERFORM public.start_app_trial(
        p_org_id,
        v_entry->>'app_id',
        COALESCE((v_entry->>'trial_days')::int, public.resolve_trial_days(v_entry->>'app_id'))
      );
    END IF;

    INSERT INTO public.organization_installed_apps
      (organization_id, app_id, installed_by, is_active, lifecycle_state)
    VALUES (
      p_org_id,
      v_entry->>'app_id',
      auth.uid(),
      true,
      COALESCE(v_entry->>'lifecycle_state', 'active')::public.app_lifecycle_state
    )
    ON CONFLICT (organization_id, app_id) DO UPDATE
      SET is_active = true,
          lifecycle_state = COALESCE(EXCLUDED.lifecycle_state, public.organization_installed_apps.lifecycle_state),
          updated_at = now();

    PERFORM public.seed_app_data(p_org_id, v_entry->>'app_id');
    PERFORM public.log_commercial_event(
      p_org_id, 'app_installed', v_entry->>'app_id', v_plan_id,
      jsonb_build_object(
        'requested_app',   p_app_id,
        'action',          v_entry->>'action',
        'state',           v_entry->>'lifecycle_state',
        'depth',           v_entry->>'depth',
        'dependency_kind', v_entry->>'dependency_kind'
      )
    );
  END LOOP;

  SELECT * INTO v_result
    FROM public.organization_installed_apps
   WHERE organization_id = p_org_id AND app_id = p_app_id;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.install_app(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.install_app(uuid, text) TO authenticated;
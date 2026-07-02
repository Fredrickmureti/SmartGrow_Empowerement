-- Step 3: server-trusted last_org_id
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS last_org_id uuid
  REFERENCES public.organizations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_last_org_id ON public.profiles(last_org_id);

-- Extend the session RPC to include last_org_id in the payload so the
-- client never has to "discover" the active workspace from localStorage
-- on first render.
CREATE OR REPLACE FUNCTION public.get_user_session_data(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  result jsonb;
  org_array jsonb := '[]'::jsonb;
  org_row record;
  plan_data jsonb;
  apps jsonb;
  features jsonb;
  overrides jsonb;
  user_count int;
  storage_used numeric;
  org_entry jsonb;
  is_admin boolean;
  role_row record;
  group_rules jsonb;
  v_logo_url text;
  v_last_org_id uuid;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.platform_admins WHERE user_id = p_user_id AND is_active = true
  ) INTO is_admin;

  SELECT last_org_id INTO v_last_org_id
    FROM public.profiles
   WHERE user_id = p_user_id
   LIMIT 1;

  FOR org_row IN
    SELECT
      o.id, o.name, o.slug,
      o.subscription_plan_id, o.subscription_status,
      o.subscription_started_at, o.subscription_ends_at,
      o.trial_ends_at, o.is_suspended, o.suspended_at, o.suspended_reason
    FROM public.organizations o
    JOIN public.user_roles ur ON ur.organization_id = o.id
    WHERE ur.user_id = p_user_id AND ur.is_active = true
    ORDER BY o.created_at ASC
  LOOP
    SELECT b.logo_url
      INTO v_logo_url
    FROM public.businesses b
    WHERE b.organization_id = org_row.id
      AND b.is_active = true
      AND b.logo_url IS NOT NULL
    ORDER BY b.created_at ASC
    LIMIT 1;

    SELECT ur.id AS role_id, ur.role, COALESCE(ur.user_type, 'internal') AS user_type
    INTO role_row
    FROM public.user_roles ur
    WHERE ur.user_id = p_user_id AND ur.organization_id = org_row.id AND ur.is_active = true
    LIMIT 1;

    SELECT jsonb_build_object(
      'id', p.id, 'name', p.name, 'description', p.description,
      'price_monthly', p.price_monthly, 'price_yearly', p.price_yearly,
      'features', COALESCE(p.features, '[]'::jsonb),
      'max_users', p.max_users, 'max_invoices_per_month', p.max_invoices_per_month,
      'max_organizations', COALESCE(p.max_organizations, 1),
      'grace_period_days', p.grace_period_days, 'max_storage_mb', p.max_storage_mb
    ) INTO plan_data
    FROM public.platform_subscription_plans p
    WHERE p.id = org_row.subscription_plan_id;

    SELECT COALESCE(jsonb_agg(app_id), '[]'::jsonb) INTO apps
    FROM public.plan_app_access
    WHERE plan_id = org_row.subscription_plan_id AND is_enabled = true;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('key', feature_key, 'value', limit_value)), '[]'::jsonb)
    INTO features
    FROM public.plan_feature_access
    WHERE plan_id = org_row.subscription_plan_id AND is_enabled = true;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'type', override_type, 'key', key, 'value', override_value, 'expires_at', expires_at
    )), '[]'::jsonb) INTO overrides
    FROM public.org_entitlement_overrides
    WHERE organization_id = org_row.id AND is_active = true
      AND (expires_at IS NULL OR expires_at > now());

    SELECT COUNT(DISTINCT user_id) INTO user_count
    FROM public.user_roles WHERE organization_id = org_row.id AND is_active = true;

    BEGIN
      SELECT COALESCE(public.get_org_storage_usage_mb(org_row.id), 0) INTO storage_used;
    EXCEPTION WHEN OTHERS THEN
      storage_used := 0;
    END;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'module', pgr.module, 'can_read', pgr.can_read, 'can_create', pgr.can_create,
      'can_write', pgr.can_write, 'can_delete', pgr.can_delete
    )), '[]'::jsonb) INTO group_rules
    FROM public.member_permission_groups mpg
    JOIN public.permission_group_rules pgr ON pgr.permission_group_id = mpg.permission_group_id
    WHERE mpg.user_id = p_user_id AND mpg.organization_id = org_row.id;

    org_entry := jsonb_build_object(
      'id', org_row.id, 'name', org_row.name, 'slug', org_row.slug,
      'logo_url', v_logo_url,
      'subscription_plan_id', org_row.subscription_plan_id,
      'subscription_status', org_row.subscription_status,
      'subscription_started_at', org_row.subscription_started_at,
      'subscription_ends_at', org_row.subscription_ends_at,
      'trial_ends_at', org_row.trial_ends_at,
      'is_suspended', org_row.is_suspended,
      'suspended_at', org_row.suspended_at,
      'suspended_reason', org_row.suspended_reason,
      'role', COALESCE(role_row.role::text, 'staff'),
      'role_id', role_row.role_id,
      'user_type', role_row.user_type,
      'plan', plan_data,
      'app_entitlements', apps,
      'entitled_features', features,
      'overrides', overrides,
      'usage_counters', jsonb_build_object(
        'users_count', user_count,
        'storage_used_mb', storage_used
      ),
      'permission_group_rules', group_rules
    );

    org_array := org_array || jsonb_build_array(org_entry);
  END LOOP;

  -- If the persisted last_org_id is no longer an org this user belongs
  -- to (revoked / deleted), drop it so the client falls back cleanly.
  IF v_last_org_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(org_array) AS e
       WHERE (e->>'id')::uuid = v_last_org_id
     ) THEN
    v_last_org_id := NULL;
  END IF;

  result := jsonb_build_object(
    'user_id', p_user_id,
    'is_platform_admin', is_admin,
    'organizations', org_array,
    'last_org_id', v_last_org_id,
    'fetched_at', now()
  );
  RETURN result;
END
$function$;

-- Small RPC the client calls when the user switches workspace, so the
-- preference round-trips through the server and is available on the
-- next reload without depending on localStorage.
CREATE OR REPLACE FUNCTION public.set_last_org_id(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  -- Only accept orgs the caller is actually a member of.
  IF p_org_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = v_user_id
       AND organization_id = p_org_id
       AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Not a member of organization' USING ERRCODE = '42501';
  END IF;

  UPDATE public.profiles
     SET last_org_id = p_org_id,
         updated_at  = now()
   WHERE user_id = v_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_last_org_id(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.set_last_org_id(uuid) FROM anon;
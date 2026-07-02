
-- Phase 1 & 2: Fix RPC to return ALL organizations with enriched plan data
CREATE OR REPLACE FUNCTION public.get_user_session_data(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
  org_array jsonb := '[]'::jsonb;
  org_row record;
  plan_row record;
  apps jsonb;
  features jsonb;
  overrides jsonb;
  user_count int;
  storage_used numeric;
  org_entry jsonb;
  is_admin boolean;
  role_row record;
  perm_rules jsonb;
BEGIN
  -- Check if user is a platform admin
  SELECT EXISTS (
    SELECT 1 FROM platform_admins WHERE user_id = p_user_id AND is_active = true
  ) INTO is_admin;

  -- Loop through ALL organizations the user belongs to
  FOR org_row IN
    SELECT o.id, o.name, o.slug, o.logo_url, o.base_currency, o.email, o.phone,
           o.address, o.city, o.state, o.postal_code, o.country,
           o.subscription_plan_id, o.subscription_status,
           o.subscription_started_at, o.subscription_ends_at,
           o.trial_ends_at, o.is_suspended, o.suspended_at, o.suspended_reason
    FROM organizations o
    JOIN user_roles ur ON ur.organization_id = o.id
    WHERE ur.user_id = p_user_id AND ur.is_active = true
    ORDER BY o.created_at ASC
  LOOP
    -- Get the user's role for this org
    SELECT ur.id AS role_id, ur.role, COALESCE(ur.user_type, 'internal') AS user_type
    INTO role_row
    FROM user_roles ur
    WHERE ur.user_id = p_user_id AND ur.organization_id = org_row.id AND ur.is_active = true
    LIMIT 1;

    -- Get plan data (enriched with all fields)
    SELECT * INTO plan_row
    FROM platform_subscription_plans
    WHERE id = org_row.subscription_plan_id;

    -- Get entitled apps for this org's plan
    SELECT COALESCE(jsonb_agg(app_id), '[]'::jsonb)
    INTO apps
    FROM plan_app_access
    WHERE plan_id = org_row.subscription_plan_id AND is_enabled = true;

    -- Get entitled features for this org's plan
    SELECT COALESCE(jsonb_agg(jsonb_build_object('key', feature_key, 'value', limit_value)), '[]'::jsonb)
    INTO features
    FROM plan_feature_access
    WHERE plan_id = org_row.subscription_plan_id AND is_enabled = true;

    -- Get org-level overrides
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'type', override_type, 'key', key, 'value', override_value, 'expires_at', expires_at
    )), '[]'::jsonb)
    INTO overrides
    FROM org_entitlement_overrides
    WHERE organization_id = org_row.id AND is_active = true
      AND (expires_at IS NULL OR expires_at > now());

    -- Get user count for this org
    SELECT COUNT(DISTINCT user_id) INTO user_count
    FROM user_roles WHERE organization_id = org_row.id AND is_active = true;

    -- Get storage usage
    BEGIN
      SELECT COALESCE(public.get_org_storage_usage_mb(org_row.id), 0) INTO storage_used;
    EXCEPTION WHEN OTHERS THEN
      storage_used := 0;
    END;

    -- Get permission group rules for user in this org
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'module', pgr.module,
      'can_read', pgr.can_read,
      'can_create', pgr.can_create,
      'can_write', pgr.can_write,
      'can_delete', pgr.can_delete
    )), '[]'::jsonb)
    INTO perm_rules
    FROM permission_group_rules pgr
    JOIN permission_group_members pgm ON pgm.group_id = pgr.group_id
    WHERE pgm.user_id = p_user_id
      AND pgr.organization_id = org_row.id;

    -- Build the org entry with all fields
    org_entry := jsonb_build_object(
      'id', org_row.id,
      'name', org_row.name,
      'slug', org_row.slug,
      'logo_url', org_row.logo_url,
      'base_currency', org_row.base_currency,
      'email', org_row.email,
      'phone', org_row.phone,
      'address', org_row.address,
      'city', org_row.city,
      'state', org_row.state,
      'postal_code', org_row.postal_code,
      'country', org_row.country,
      'subscription_plan_id', org_row.subscription_plan_id,
      'subscription_status', org_row.subscription_status,
      'subscription_started_at', org_row.subscription_started_at,
      'subscription_ends_at', org_row.subscription_ends_at,
      'trial_ends_at', org_row.trial_ends_at,
      'is_suspended', org_row.is_suspended,
      'suspended_at', org_row.suspended_at,
      'suspended_reason', org_row.suspended_reason,
      'role', COALESCE(role_row.role, 'internal'),
      'role_id', role_row.role_id,
      'user_type', COALESCE(role_row.user_type, 'internal'),
      'plan', CASE WHEN plan_row IS NOT NULL THEN jsonb_build_object(
        'id', plan_row.id,
        'name', plan_row.name,
        'description', plan_row.description,
        'price_monthly', plan_row.price_monthly,
        'price_yearly', plan_row.price_yearly,
        'features', COALESCE(plan_row.features, '[]'::jsonb),
        'max_users', plan_row.max_users,
        'max_invoices_per_month', plan_row.max_invoices_per_month,
        'max_organizations', COALESCE(plan_row.max_organizations, 1),
        'grace_period_days', plan_row.grace_period_days,
        'max_storage_mb', plan_row.max_storage_mb
      ) ELSE NULL END,
      'app_entitlements', apps,
      'entitlements', (SELECT COALESCE(jsonb_agg(f->>'key'), '[]'::jsonb) FROM jsonb_array_elements(features) AS f),
      'feature_limits', (
        SELECT COALESCE(jsonb_object_agg(f->>'key', f->'value'), '{}'::jsonb)
        FROM jsonb_array_elements(features) AS f
        WHERE f->'value' IS NOT NULL AND f->>'value' != 'null'
      ),
      'entitled_features', features,
      'overrides', overrides,
      'limit_overrides', (
        SELECT COALESCE(jsonb_object_agg(ov->>'key', ov->'value'), '{}'::jsonb)
        FROM jsonb_array_elements(overrides) AS ov
        WHERE ov->>'type' = 'limit'
      ),
      'usage_counters', jsonb_build_object(
        'users_count', user_count,
        'invoices_this_month', 0,
        'businesses_count', 0,
        'storage_used_mb', storage_used
      ),
      'permission_group_rules', perm_rules
    );

    org_array := org_array || jsonb_build_array(org_entry);
  END LOOP;

  -- If no orgs found, return error
  IF jsonb_array_length(org_array) = 0 THEN
    RETURN jsonb_build_object('error', 'no_organization');
  END IF;

  result := jsonb_build_object(
    'organizations', org_array,
    'user_id', p_user_id,
    'is_platform_admin', is_admin,
    'fetched_at', now()
  );

  RETURN result;
END;
$$;

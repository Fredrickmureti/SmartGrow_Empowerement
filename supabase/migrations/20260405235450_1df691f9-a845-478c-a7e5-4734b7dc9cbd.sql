
-- Fix plan lookup: use explicit FOUND check instead of IS NOT NULL on record
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
  plan_data jsonb;
  apps jsonb;
  features jsonb;
  overrides jsonb;
  user_count int;
  storage_used numeric;
  org_entry jsonb;
  is_admin boolean;
  role_row record;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM platform_admins WHERE user_id = p_user_id AND is_active = true
  ) INTO is_admin;

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
    SELECT ur.id AS role_id, ur.role, COALESCE(ur.user_type, 'internal') AS user_type
    INTO role_row
    FROM user_roles ur
    WHERE ur.user_id = p_user_id AND ur.organization_id = org_row.id AND ur.is_active = true
    LIMIT 1;

    -- Get plan as JSON directly to avoid record NULL issues
    SELECT jsonb_build_object(
      'id', p.id,
      'name', p.name,
      'description', p.description,
      'price_monthly', p.price_monthly,
      'price_yearly', p.price_yearly,
      'features', COALESCE(p.features, '[]'::jsonb),
      'max_users', p.max_users,
      'max_invoices_per_month', p.max_invoices_per_month,
      'max_organizations', COALESCE(p.max_organizations, 1),
      'grace_period_days', p.grace_period_days,
      'max_storage_mb', p.max_storage_mb
    ) INTO plan_data
    FROM platform_subscription_plans p
    WHERE p.id = org_row.subscription_plan_id;

    SELECT COALESCE(jsonb_agg(app_id), '[]'::jsonb)
    INTO apps
    FROM plan_app_access
    WHERE plan_id = org_row.subscription_plan_id AND is_enabled = true;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('key', feature_key, 'value', limit_value)), '[]'::jsonb)
    INTO features
    FROM plan_feature_access
    WHERE plan_id = org_row.subscription_plan_id AND is_enabled = true;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'type', override_type, 'key', key, 'value', override_value, 'expires_at', expires_at
    )), '[]'::jsonb)
    INTO overrides
    FROM org_entitlement_overrides
    WHERE organization_id = org_row.id AND is_active = true
      AND (expires_at IS NULL OR expires_at > now());

    SELECT COUNT(DISTINCT user_id) INTO user_count
    FROM user_roles WHERE organization_id = org_row.id AND is_active = true;

    BEGIN
      SELECT COALESCE(public.get_org_storage_usage_mb(org_row.id), 0) INTO storage_used;
    EXCEPTION WHEN OTHERS THEN
      storage_used := 0;
    END;

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
      'plan', COALESCE(plan_data, 'null'::jsonb),
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
      'permission_group_rules', '[]'::jsonb
    );

    org_array := org_array || jsonb_build_array(org_entry);
  END LOOP;

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

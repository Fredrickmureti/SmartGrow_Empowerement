-- Fix storage_used_mb in get_user_session_data RPC
-- Replace the hardcoded 0 with actual storage calculation
CREATE OR REPLACE FUNCTION public.get_user_session_data(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
  org_record record;
  plan_record record;
  apps jsonb;
  features jsonb;
  overrides jsonb;
  user_count int;
  storage_used numeric;
BEGIN
  -- Get user's organization
  SELECT o.id, o.name, o.subscription_plan_id, o.subscription_status,
         o.trial_ends_at, o.is_suspended, o.subscription_ends_at
  INTO org_record
  FROM organizations o
  JOIN user_roles ur ON ur.organization_id = o.id
  WHERE ur.user_id = p_user_id
  LIMIT 1;

  IF org_record IS NULL THEN
    RETURN jsonb_build_object('error', 'no_organization');
  END IF;

  -- Get plan details
  SELECT * INTO plan_record
  FROM platform_subscription_plans
  WHERE id = org_record.subscription_plan_id;

  -- Get entitled apps for this plan
  SELECT COALESCE(jsonb_agg(app_id), '[]'::jsonb)
  INTO apps
  FROM plan_app_access
  WHERE plan_id = org_record.subscription_plan_id
    AND is_enabled = true;

  -- Get entitled features for this plan
  SELECT COALESCE(jsonb_agg(jsonb_build_object('key', feature_key, 'value', feature_value)), '[]'::jsonb)
  INTO features
  FROM plan_feature_access
  WHERE plan_id = org_record.subscription_plan_id
    AND is_enabled = true;

  -- Get org-specific overrides
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'type', override_type,
    'key', key,
    'value', override_value,
    'expires_at', expires_at
  )), '[]'::jsonb)
  INTO overrides
  FROM org_entitlement_overrides
  WHERE organization_id = org_record.id
    AND is_active = true
    AND (expires_at IS NULL OR expires_at > now());

  -- Get user count for this org
  SELECT COUNT(DISTINCT user_id)
  INTO user_count
  FROM user_roles
  WHERE organization_id = org_record.id;

  -- Get REAL storage usage (was previously hardcoded to 0)
  BEGIN
    SELECT COALESCE(public.get_org_storage_usage_mb(org_record.id), 0)
    INTO storage_used;
  EXCEPTION WHEN OTHERS THEN
    storage_used := 0;
  END;

  result := jsonb_build_object(
    'organization', jsonb_build_object(
      'id', org_record.id,
      'name', org_record.name,
      'subscription_status', org_record.subscription_status,
      'is_suspended', org_record.is_suspended,
      'trial_ends_at', org_record.trial_ends_at,
      'subscription_ends_at', org_record.subscription_ends_at
    ),
    'plan', CASE WHEN plan_record IS NOT NULL THEN jsonb_build_object(
      'id', plan_record.id,
      'name', plan_record.name,
      'max_users', plan_record.max_users,
      'max_storage_mb', plan_record.max_storage_mb
    ) ELSE NULL END,
    'entitled_apps', apps,
    'entitled_features', features,
    'overrides', overrides,
    'usage', jsonb_build_object(
      'user_count', user_count,
      'storage_used_mb', storage_used
    )
  );

  RETURN result;
END;
$$;

-- Insert platform_logo_url setting if it doesn't exist
INSERT INTO platform_settings (setting_key, setting_value, description)
VALUES ('platform_logo_url', '', 'URL for the platform logo used in admin reports and branding')
ON CONFLICT (setting_key) DO NOTHING;
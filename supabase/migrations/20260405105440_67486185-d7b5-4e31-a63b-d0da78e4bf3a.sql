
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

  SELECT * INTO plan_record
  FROM platform_subscription_plans
  WHERE id = org_record.subscription_plan_id;

  SELECT COALESCE(jsonb_agg(app_id), '[]'::jsonb)
  INTO apps
  FROM plan_app_access
  WHERE plan_id = org_record.subscription_plan_id
    AND is_enabled = true;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('key', feature_key, 'value', limit_value)), '[]'::jsonb)
  INTO features
  FROM plan_feature_access
  WHERE plan_id = org_record.subscription_plan_id
    AND is_enabled = true;

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

  SELECT COUNT(DISTINCT user_id)
  INTO user_count
  FROM user_roles
  WHERE organization_id = org_record.id;

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


-- Storage limit check function
CREATE OR REPLACE FUNCTION public.check_storage_limit(p_organization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_usage_mb numeric;
  v_limit_mb integer;
  v_override_limit integer;
  v_effective_limit integer;
  v_pct numeric;
BEGIN
  SELECT COALESCE(public.get_org_storage_usage_mb(p_organization_id), 0) INTO v_usage_mb;

  SELECT psp.max_storage_mb INTO v_limit_mb
  FROM organizations o
  JOIN platform_subscription_plans psp ON psp.id = o.subscription_plan_id
  WHERE o.id = p_organization_id;

  SELECT (override_value->>'value')::integer INTO v_override_limit
  FROM org_entitlement_overrides
  WHERE organization_id = p_organization_id
    AND override_type = 'limit'
    AND key = 'max_storage_mb'
    AND is_active = true
    AND (expires_at IS NULL OR expires_at > now());

  v_effective_limit := COALESCE(v_override_limit, v_limit_mb);

  IF v_effective_limit IS NULL OR v_effective_limit = 0 THEN
    RETURN jsonb_build_object(
      'allowed', true, 'usage_mb', ROUND(v_usage_mb, 2),
      'limit_mb', null, 'percentage', 0, 'status', 'unlimited'
    );
  END IF;

  v_pct := ROUND((v_usage_mb / v_effective_limit) * 100, 1);

  RETURN jsonb_build_object(
    'allowed', v_usage_mb < v_effective_limit,
    'usage_mb', ROUND(v_usage_mb, 2),
    'limit_mb', v_effective_limit,
    'percentage', v_pct,
    'status', CASE
      WHEN v_pct >= 100 THEN 'exceeded'
      WHEN v_pct >= 80 THEN 'warning'
      ELSE 'ok'
    END
  );
END;
$$;

-- Downgrade impact check function
CREATE OR REPLACE FUNCTION public.check_downgrade_impact(p_org_id uuid, p_new_plan_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_plan_id uuid;
  v_user_count integer;
  v_new_max_users integer;
  v_storage_mb numeric;
  v_new_max_storage integer;
  v_lost_apps jsonb;
  v_lost_features jsonb;
  v_warnings jsonb := '[]'::jsonb;
BEGIN
  SELECT subscription_plan_id INTO v_current_plan_id
  FROM organizations WHERE id = p_org_id;

  SELECT max_users, max_storage_mb INTO v_new_max_users, v_new_max_storage
  FROM platform_subscription_plans WHERE id = p_new_plan_id;

  SELECT COUNT(*) INTO v_user_count
  FROM user_roles WHERE organization_id = p_org_id;

  IF v_new_max_users IS NOT NULL AND v_new_max_users > 0 AND v_user_count > v_new_max_users THEN
    v_warnings := v_warnings || jsonb_build_object(
      'type', 'user_limit', 'severity', 'critical',
      'message', format('Organization has %s users but new plan allows only %s', v_user_count, v_new_max_users),
      'current', v_user_count, 'limit', v_new_max_users
    );
  END IF;

  SELECT COALESCE(public.get_org_storage_usage_mb(p_org_id), 0) INTO v_storage_mb;

  IF v_new_max_storage IS NOT NULL AND v_new_max_storage > 0 AND v_storage_mb > v_new_max_storage THEN
    v_warnings := v_warnings || jsonb_build_object(
      'type', 'storage_limit', 'severity', 'warning',
      'message', format('Organization uses %s MB but new plan allows only %s MB', ROUND(v_storage_mb, 1), v_new_max_storage),
      'current', ROUND(v_storage_mb, 1), 'limit', v_new_max_storage
    );
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('app_id', ca.app_id)), '[]'::jsonb)
  INTO v_lost_apps
  FROM plan_app_access ca
  WHERE ca.plan_id = v_current_plan_id AND ca.is_enabled = true
    AND ca.app_id NOT IN (
      SELECT na.app_id FROM plan_app_access na WHERE na.plan_id = p_new_plan_id AND na.is_enabled = true
    );

  IF jsonb_array_length(v_lost_apps) > 0 THEN
    v_warnings := v_warnings || jsonb_build_object(
      'type', 'lost_apps', 'severity', 'critical',
      'message', format('Organization will lose access to %s app(s)', jsonb_array_length(v_lost_apps)),
      'apps', v_lost_apps
    );
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('feature_key', cf.feature_key)), '[]'::jsonb)
  INTO v_lost_features
  FROM plan_feature_access cf
  WHERE cf.plan_id = v_current_plan_id AND cf.is_enabled = true
    AND cf.feature_key NOT IN (
      SELECT nf.feature_key FROM plan_feature_access nf WHERE nf.plan_id = p_new_plan_id AND nf.is_enabled = true
    );

  IF jsonb_array_length(v_lost_features) > 0 THEN
    v_warnings := v_warnings || jsonb_build_object(
      'type', 'lost_features', 'severity', 'warning',
      'message', format('Organization will lose %s premium feature(s)', jsonb_array_length(v_lost_features)),
      'features', v_lost_features
    );
  END IF;

  RETURN jsonb_build_object(
    'has_warnings', jsonb_array_length(v_warnings) > 0,
    'warnings', v_warnings,
    'current_plan_id', v_current_plan_id,
    'new_plan_id', p_new_plan_id
  );
END;
$$;


CREATE OR REPLACE FUNCTION public.get_user_session_data(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
  v_org_data JSONB;
  v_first_org_id UUID;
  v_trial_all_apps BOOLEAN;
  v_all_app_ids TEXT[];
BEGIN
  -- Get trial_all_apps_access setting from platform_settings
  SELECT COALESCE(
    (SELECT setting_value::boolean 
     FROM platform_settings 
     WHERE setting_key = 'trial_all_apps_access'),
    true
  ) INTO v_trial_all_apps;

  -- Get all unique app IDs from plan_app_access (for trial mode)
  SELECT ARRAY(
    SELECT DISTINCT app_id 
    FROM plan_app_access
  ) INTO v_all_app_ids;

  IF v_all_app_ids IS NULL OR array_length(v_all_app_ids, 1) IS NULL THEN
    v_all_app_ids := ARRAY['finance','sales','purchases','inventory','pos','crm','hr','projects','reports','documents','sign','spreadsheets','platform'];
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'id', o.id,
      'name', o.name,
      'slug', o.slug,
      'logo_url', o.logo_url,
      'base_currency', o.base_currency,
      'email', o.email,
      'phone', o.phone,
      'address', o.address,
      'city', o.city,
      'state', o.state,
      'postal_code', o.postal_code,
      'country', o.country,
      'subscription_plan_id', o.subscription_plan_id,
      'subscription_status', o.subscription_status,
      'subscription_started_at', o.subscription_started_at,
      'subscription_ends_at', o.subscription_ends_at,
      'trial_ends_at', o.trial_ends_at,
      'is_suspended', o.is_suspended,
      'suspended_at', o.suspended_at,
      'suspended_reason', o.suspended_reason,
      'role', ur.role,
      'role_id', ur.id,
      'user_type', ur.user_type,
      'computed_status', jsonb_build_object(
        'is_active', CASE
          WHEN o.is_suspended = true THEN false
          WHEN o.subscription_status = 'active' AND (o.subscription_ends_at IS NULL OR o.subscription_ends_at > NOW()) THEN true
          WHEN o.subscription_status = 'trial' AND (o.trial_ends_at IS NULL OR o.trial_ends_at > NOW()) THEN true
          ELSE false
        END,
        'is_suspended', COALESCE(o.is_suspended, false),
        'is_trialing', o.subscription_status = 'trial' AND (o.trial_ends_at IS NULL OR o.trial_ends_at > NOW()),
        'is_expired', CASE
          WHEN o.is_suspended = true THEN false
          WHEN o.subscription_status IN ('expired', 'cancelled') THEN true
          WHEN o.subscription_status = 'trial' AND o.trial_ends_at IS NOT NULL AND o.trial_ends_at <= NOW() THEN true
          WHEN o.subscription_status = 'active' AND o.subscription_ends_at IS NOT NULL AND o.subscription_ends_at <= NOW() THEN true
          ELSE false
        END,
        'days_remaining', CASE
          WHEN o.subscription_status = 'trial' AND o.trial_ends_at IS NOT NULL 
            THEN GREATEST(0, EXTRACT(DAY FROM o.trial_ends_at - NOW())::integer)
          WHEN o.subscription_status = 'active' AND o.subscription_ends_at IS NOT NULL 
            THEN GREATEST(0, EXTRACT(DAY FROM o.subscription_ends_at - NOW())::integer)
          ELSE NULL
        END
      ),
      'plan', (
        SELECT jsonb_build_object(
          'id', psp.id,
          'name', psp.name,
          'description', psp.description,
          'price_monthly', psp.price_monthly,
          'price_yearly', psp.price_yearly,
          'features', psp.features,
          'max_users', psp.max_users,
          'max_invoices_per_month', psp.max_invoices_per_month,
          'max_organizations', psp.max_organizations,
          'grace_period_days', psp.grace_period_days,
          'max_storage_mb', psp.max_storage_mb
        )
        FROM platform_subscription_plans psp
        WHERE psp.id = o.subscription_plan_id
      ),
      -- Entitlements: plan features + feature overrides (grant)
      'entitlements', (
        SELECT COALESCE(jsonb_agg(DISTINCT feat), '[]'::jsonb)
        FROM (
          SELECT pfa.feature_key AS feat
          FROM plan_feature_access pfa
          WHERE pfa.plan_id = o.subscription_plan_id AND pfa.is_enabled = true
          UNION
          SELECT oeo.key AS feat
          FROM org_entitlement_overrides oeo
          WHERE oeo.organization_id = o.id
            AND oeo.override_type = 'feature'
            AND oeo.is_active = true
            AND (oeo.expires_at IS NULL OR oeo.expires_at > NOW())
            AND (oeo.override_value)::text::boolean = true
        ) sub
      ),
      'feature_limits', (
        SELECT COALESCE(
          jsonb_object_agg(pfa.feature_key, pfa.limit_value),
          '{}'::jsonb
        )
        FROM plan_feature_access pfa
        WHERE pfa.plan_id = o.subscription_plan_id
        AND pfa.limit_value IS NOT NULL
      ),
      -- App entitlements: plan apps + app overrides
      'app_entitlements', (
        CASE 
          WHEN o.subscription_status = 'trial' 
               AND (o.trial_ends_at IS NULL OR o.trial_ends_at > NOW())
               AND v_trial_all_apps = true
          THEN to_jsonb(v_all_app_ids)
          ELSE (
            SELECT COALESCE(jsonb_agg(DISTINCT app), '[]'::jsonb)
            FROM (
              SELECT paa.app_id AS app
              FROM plan_app_access paa
              WHERE paa.plan_id = o.subscription_plan_id AND paa.is_enabled = true
              UNION
              SELECT oeo.key AS app
              FROM org_entitlement_overrides oeo
              WHERE oeo.organization_id = o.id
                AND oeo.override_type = 'app'
                AND oeo.is_active = true
                AND (oeo.expires_at IS NULL OR oeo.expires_at > NOW())
                AND (oeo.override_value)::text::boolean = true
            ) sub
          )
        END
      ),
      -- Limit overrides for frontend display
      'limit_overrides', (
        SELECT COALESCE(
          jsonb_object_agg(oeo.key, oeo.override_value),
          '{}'::jsonb
        )
        FROM org_entitlement_overrides oeo
        WHERE oeo.organization_id = o.id
          AND oeo.override_type = 'limit'
          AND oeo.is_active = true
          AND (oeo.expires_at IS NULL OR oeo.expires_at > NOW())
      ),
      -- Usage counters (real-time counts for limit enforcement)
      'usage_counters', jsonb_build_object(
        'users_count', (
          SELECT COUNT(*)::integer 
          FROM user_roles ur2 
          WHERE ur2.organization_id = o.id AND ur2.is_active = true
        ),
        'invoices_this_month', (
          SELECT COUNT(*)::integer 
          FROM invoices inv 
          WHERE inv.organization_id = o.id 
            AND inv.created_at >= date_trunc('month', NOW())
        ),
        'businesses_count', (
          SELECT COUNT(*)::integer 
          FROM businesses b 
          WHERE b.organization_id = o.id
        ),
        'storage_used_mb', 0
      ),
      -- Permission group rules
      'permission_group_rules', (
        SELECT COALESCE(jsonb_agg(
          jsonb_build_object(
            'module', pgr.module,
            'can_read', pgr.can_read,
            'can_create', pgr.can_create,
            'can_write', pgr.can_write,
            'can_delete', pgr.can_delete
          )
        ), '[]'::jsonb)
        FROM member_permission_groups mpg
        JOIN permission_group_rules pgr ON pgr.permission_group_id = mpg.permission_group_id
        WHERE mpg.user_id = p_user_id
          AND mpg.organization_id = o.id
      )
    )
  )
  INTO v_org_data
  FROM user_roles ur
  JOIN organizations o ON o.id = ur.organization_id
  WHERE ur.user_id = p_user_id
  AND ur.is_active = true;

  v_first_org_id := (v_org_data->0->>'id')::UUID;

  v_result := jsonb_build_object(
    'organizations', COALESCE(v_org_data, '[]'::jsonb),
    'user_id', p_user_id,
    'is_platform_admin', public.is_platform_admin(p_user_id),
    'fetched_at', NOW()
  );

  RETURN v_result;
END;
$$;

-- =====================================================
-- ENTITLEMENTS-AT-LOGIN: Single RPC for all session data
-- Eliminates waterfall of async calls that causes flicker
-- =====================================================

CREATE OR REPLACE FUNCTION public.get_user_session_data(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_result JSONB;
  v_org_data JSONB;
  v_first_org_id UUID;
BEGIN
  -- Get all organizations with their subscription data and user roles
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
      -- Pre-compute subscription status flags
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
      -- Include plan details
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
          'max_organizations', psp.max_organizations
        )
        FROM platform_subscription_plans psp
        WHERE psp.id = o.subscription_plan_id
      ),
      -- Include enabled feature keys as an array for O(1) lookup
      'entitlements', (
        SELECT COALESCE(jsonb_agg(pfa.feature_key), '[]'::jsonb)
        FROM plan_feature_access pfa
        WHERE pfa.plan_id = o.subscription_plan_id
        AND pfa.is_enabled = true
      ),
      -- Include feature limits as key-value object
      'feature_limits', (
        SELECT COALESCE(
          jsonb_object_agg(pfa.feature_key, pfa.limit_value),
          '{}'::jsonb
        )
        FROM plan_feature_access pfa
        WHERE pfa.plan_id = o.subscription_plan_id
        AND pfa.limit_value IS NOT NULL
      )
    )
  )
  INTO v_org_data
  FROM user_roles ur
  JOIN organizations o ON o.id = ur.organization_id
  WHERE ur.user_id = p_user_id
  AND ur.is_active = true;

  -- Get the first org ID for usage data
  SELECT (v_org_data->0->>'id')::UUID INTO v_first_org_id;

  -- Build complete result
  v_result := jsonb_build_object(
    'organizations', COALESCE(v_org_data, '[]'::jsonb),
    'user_id', p_user_id,
    'is_platform_admin', public.is_platform_admin(p_user_id),
    'fetched_at', NOW()
  );

  RETURN v_result;
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.get_user_session_data(UUID) TO authenticated;

-- =====================================================
-- RLS POLICIES: Server-side subscription enforcement
-- These ensure users can't bypass UI gating via API
-- =====================================================

-- Helper function for RLS to check if org subscription is active
CREATE OR REPLACE FUNCTION public.rls_check_org_subscription_active(p_org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN o.is_suspended = true THEN false
    WHEN o.subscription_status = 'active' AND (o.subscription_ends_at IS NULL OR o.subscription_ends_at > NOW()) THEN true
    WHEN o.subscription_status = 'trial' AND (o.trial_ends_at IS NULL OR o.trial_ends_at > NOW()) THEN true
    ELSE false
  END
  FROM organizations o
  WHERE o.id = p_org_id
$$;

-- Helper for RLS to check feature access
CREATE OR REPLACE FUNCTION public.rls_check_feature_access(p_org_id UUID, p_feature_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM organizations o
    JOIN plan_feature_access pfa ON pfa.plan_id = o.subscription_plan_id
    WHERE o.id = p_org_id
    AND pfa.feature_key = p_feature_key
    AND pfa.is_enabled = true
    AND public.rls_check_org_subscription_active(p_org_id)
  )
$$;

GRANT EXECUTE ON FUNCTION public.rls_check_org_subscription_active(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rls_check_feature_access(UUID, TEXT) TO authenticated;
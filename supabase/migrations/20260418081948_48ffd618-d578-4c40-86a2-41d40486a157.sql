
-- ============================================================================
-- Unified entitlement check: check_org_app_access
-- Returns true if the org's subscription is active AND the app is in plan
-- (or overridden on for the org).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.check_org_app_access(
  _org_id uuid,
  _app_id text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org RECORD;
  v_subscription_active boolean;
  v_override boolean;
  v_in_plan boolean;
BEGIN
  IF _org_id IS NULL OR _app_id IS NULL OR _app_id = '' THEN
    RETURN false;
  END IF;

  -- 1. Load org subscription state
  SELECT
    subscription_status,
    subscription_ends_at,
    trial_ends_at,
    is_suspended,
    plan_id
  INTO v_org
  FROM public.organizations
  WHERE id = _org_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_org.is_suspended THEN
    RETURN false;
  END IF;

  -- 2. Subscription must be active or trialing within window (NULL status = legacy/no-subscription = treat active)
  v_subscription_active :=
    v_org.subscription_status IS NULL OR
    (v_org.subscription_status = 'active'
       AND (v_org.subscription_ends_at IS NULL OR v_org.subscription_ends_at > now())) OR
    (v_org.subscription_status = 'trial'
       AND (v_org.trial_ends_at IS NULL OR v_org.trial_ends_at > now()));

  IF NOT v_subscription_active THEN
    RETURN false;
  END IF;

  -- 3. Per-org override (app scope) wins
  SELECT is_enabled
  INTO v_override
  FROM public.org_entitlement_overrides
  WHERE organization_id = _org_id
    AND scope = 'app'
    AND key = _app_id
  LIMIT 1;

  IF v_override IS NOT NULL THEN
    RETURN v_override;
  END IF;

  -- 4. Plan-level app access
  IF v_org.plan_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT COALESCE(is_enabled, false)
  INTO v_in_plan
  FROM public.plan_app_access
  WHERE plan_id = v_org.plan_id
    AND app_id = _app_id
  LIMIT 1;

  RETURN COALESCE(v_in_plan, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_org_app_access(uuid, text) TO authenticated, anon, service_role;

-- ============================================================================
-- Helper: is this app installed/active for the org?
-- ============================================================================
CREATE OR REPLACE FUNCTION public.check_org_app_installed(
  _org_id uuid,
  _app_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_installed_apps
    WHERE organization_id = _org_id
      AND app_id = _app_id
      AND COALESCE(is_active, true) = true
  );
$$;

GRANT EXECUTE ON FUNCTION public.check_org_app_installed(uuid, text) TO authenticated, anon, service_role;

-- ============================================================================
-- Replace check_org_feature_access_v2 with the unified resolver
-- Order: subscription → override(feature) → plan_feature_access(feature)
--        → resolve to app via app_included_features → check_org_app_access
-- ============================================================================
CREATE OR REPLACE FUNCTION public.check_org_feature_access_v2(
  _org_id uuid,
  _feature_key text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org RECORD;
  v_subscription_active boolean;
  v_override boolean;
  v_in_plan boolean;
  v_app_id text;
BEGIN
  IF _org_id IS NULL OR _feature_key IS NULL OR _feature_key = '' THEN
    RETURN false;
  END IF;

  SELECT
    subscription_status,
    subscription_ends_at,
    trial_ends_at,
    is_suspended,
    plan_id
  INTO v_org
  FROM public.organizations
  WHERE id = _org_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_org.is_suspended THEN
    RETURN false;
  END IF;

  v_subscription_active :=
    v_org.subscription_status IS NULL OR
    (v_org.subscription_status = 'active'
       AND (v_org.subscription_ends_at IS NULL OR v_org.subscription_ends_at > now())) OR
    (v_org.subscription_status = 'trial'
       AND (v_org.trial_ends_at IS NULL OR v_org.trial_ends_at > now()));

  IF NOT v_subscription_active THEN
    RETURN false;
  END IF;

  -- 1. Per-org feature override
  SELECT is_enabled
  INTO v_override
  FROM public.org_entitlement_overrides
  WHERE organization_id = _org_id
    AND scope = 'feature'
    AND key = _feature_key
  LIMIT 1;

  IF v_override IS NOT NULL THEN
    RETURN v_override;
  END IF;

  -- 2. Direct plan_feature_access entry (premium add-on features)
  IF v_org.plan_id IS NOT NULL THEN
    SELECT is_enabled
    INTO v_in_plan
    FROM public.plan_feature_access
    WHERE plan_id = v_org.plan_id
      AND feature_key = _feature_key
    LIMIT 1;

    IF v_in_plan IS NOT NULL THEN
      RETURN v_in_plan;
    END IF;
  END IF;

  -- 3. The key may itself BE an app id (e.g. 'hr', 'banking', 'etims')
  --    Also resolve features that belong to an app via app_included_features.
  --    We try the key as an app_id first, then any apps that include this feature.
  IF EXISTS (SELECT 1 FROM public.plan_app_access WHERE app_id = _feature_key LIMIT 1) THEN
    RETURN public.check_org_app_access(_org_id, _feature_key);
  END IF;

  -- 4. Resolve feature → app via app_included_features. If ANY app that
  --    includes this feature is granted to the org, allow.
  FOR v_app_id IN
    SELECT app_id
    FROM public.app_included_features
    WHERE feature_key = _feature_key
  LOOP
    IF public.check_org_app_access(_org_id, v_app_id) THEN
      RETURN true;
    END IF;
  END LOOP;

  -- 5. Nothing matched
  RETURN false;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_org_feature_access_v2(uuid, text) TO authenticated, anon, service_role;

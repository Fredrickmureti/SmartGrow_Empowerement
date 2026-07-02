
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

  SELECT
    subscription_status,
    subscription_ends_at,
    trial_ends_at,
    is_suspended,
    subscription_plan_id AS plan_id
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
    subscription_plan_id AS plan_id
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

  IF EXISTS (SELECT 1 FROM public.plan_app_access WHERE app_id = _feature_key LIMIT 1) THEN
    RETURN public.check_org_app_access(_org_id, _feature_key);
  END IF;

  FOR v_app_id IN
    SELECT app_id
    FROM public.app_included_features
    WHERE feature_key = _feature_key
  LOOP
    IF public.check_org_app_access(_org_id, v_app_id) THEN
      RETURN true;
    END IF;
  END LOOP;

  RETURN false;
END;
$$;

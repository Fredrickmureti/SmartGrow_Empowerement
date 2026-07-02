-- =========================================================================
-- app_state_for_org(org_id, app_id) — single-source-of-truth lifecycle state
-- =========================================================================
-- Returns one of:
--   'not_installed'  — org has no installed_apps row for this app
--   'active'         — installed + paid plan + sub active
--   'trial'          — installed + active app trial
--   'grace'          — sub past_due / trial just lapsed (<= 7 day grace)
--   'read_only'      — org-level subscription expired but not suspended
--   'expired_trial'  — app trial finished without conversion
--   'suspended'      — organizations.is_suspended = true
--
-- Used by useEntitlementGate to decide whether to show
-- "Subscribe", "Renew", or "Read-only — historical data only" banners,
-- and by edge functions to short-circuit writes uniformly.
CREATE OR REPLACE FUNCTION public.app_state_for_org(
  _org_id uuid,
  _app_id text
) RETURNS text
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_app text := CASE WHEN _app_id = 'hr' THEN 'employees' ELSE _app_id END;
  v_org RECORD;
  v_installed RECORD;
  v_trial RECORD;
  v_in_plan boolean;
  v_grace_days constant int := 7;
BEGIN
  IF _org_id IS NULL OR v_app IS NULL OR v_app = '' THEN
    RETURN 'not_installed';
  END IF;

  SELECT subscription_status, subscription_ends_at, trial_ends_at,
         is_suspended, subscription_plan_id AS plan_id
    INTO v_org
    FROM public.organizations
   WHERE id = _org_id;

  IF NOT FOUND THEN RETURN 'not_installed'; END IF;
  IF COALESCE(v_org.is_suspended, false) THEN RETURN 'suspended'; END IF;

  -- Must be installed to have any state besides not_installed.
  SELECT app_id, lifecycle_state, is_active
    INTO v_installed
    FROM public.organization_installed_apps
   WHERE organization_id = _org_id AND app_id = v_app
   LIMIT 1;

  IF NOT FOUND OR COALESCE(v_installed.is_active, true) = false THEN
    RETURN 'not_installed';
  END IF;

  -- Active app trial wins over plan checks.
  SELECT status, expires_at
    INTO v_trial
    FROM public.app_trial_status
   WHERE organization_id = _org_id AND app_id = v_app
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_trial.status = 'active' AND v_trial.expires_at > now() THEN
    RETURN 'trial';
  END IF;

  -- Org-level subscription expired but not suspended → read_only window.
  IF v_org.subscription_status = 'expired'
     OR (v_org.subscription_ends_at IS NOT NULL AND v_org.subscription_ends_at <= now()) THEN
    -- Inside grace? show grace; outside → read_only.
    IF v_org.subscription_ends_at IS NOT NULL
       AND v_org.subscription_ends_at > (now() - (v_grace_days || ' days')::interval) THEN
      RETURN 'grace';
    END IF;
    RETURN 'read_only';
  END IF;

  -- Trial expired without conversion → expired_trial only if no active plan inclusion.
  IF v_trial.status IN ('expired','cancelled') THEN
    SELECT COALESCE(is_enabled, false)
      INTO v_in_plan
      FROM public.plan_app_access
     WHERE plan_id = v_org.plan_id AND app_id = v_app
     LIMIT 1;
    IF NOT COALESCE(v_in_plan, false) THEN
      RETURN 'expired_trial';
    END IF;
  END IF;

  -- Past_due → grace
  IF v_org.subscription_status = 'past_due' THEN RETURN 'grace'; END IF;

  RETURN 'active';
END;
$$;

COMMENT ON FUNCTION public.app_state_for_org(uuid, text) IS
  'Single-source-of-truth lifecycle state for (org, app). Returns: not_installed | active | trial | grace | read_only | expired_trial | suspended.';

GRANT EXECUTE ON FUNCTION public.app_state_for_org(uuid, text) TO authenticated;
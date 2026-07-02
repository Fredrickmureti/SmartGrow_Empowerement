
CREATE OR REPLACE FUNCTION public.app_state_for_org(_org_id uuid, _app_id text)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_app text := CASE WHEN _app_id = 'hr' THEN 'employees' ELSE _app_id END;
  v_org RECORD; v_installed RECORD; v_trial RECORD; v_in_plan boolean;
  v_grace_days constant int := 7;
  v_app_grace_days constant int := 3;
BEGIN
  IF _org_id IS NULL OR v_app IS NULL OR v_app = '' THEN RETURN 'not_installed'; END IF;
  SELECT subscription_status, subscription_ends_at, trial_ends_at, is_suspended,
         subscription_plan_id AS plan_id INTO v_org
    FROM public.organizations WHERE id = _org_id;
  IF NOT FOUND THEN RETURN 'not_installed'; END IF;
  IF COALESCE(v_org.is_suspended, false) THEN RETURN 'suspended'; END IF;
  SELECT app_id, lifecycle_state, is_active INTO v_installed
    FROM public.organization_installed_apps
   WHERE organization_id = _org_id AND app_id = v_app LIMIT 1;
  IF NOT FOUND OR COALESCE(v_installed.is_active, true) = false THEN RETURN 'not_installed'; END IF;
  SELECT status, expires_at INTO v_trial FROM public.app_trial_status
   WHERE organization_id = _org_id AND app_id = v_app
   ORDER BY created_at DESC LIMIT 1;
  IF v_trial.status = 'active' AND v_trial.expires_at > now() THEN RETURN 'trial'; END IF;
  IF v_org.subscription_status = 'expired'
     OR (v_org.subscription_ends_at IS NOT NULL AND v_org.subscription_ends_at <= now()) THEN
    IF v_org.subscription_ends_at IS NOT NULL
       AND v_org.subscription_ends_at > (now() - (v_grace_days || ' days')::interval) THEN
      RETURN 'grace';
    END IF;
    RETURN 'read_only';
  END IF;
  IF v_trial.status IN ('expired','cancelled') THEN
    SELECT COALESCE(is_enabled, false) INTO v_in_plan FROM public.plan_app_access
     WHERE plan_id = v_org.plan_id AND app_id = v_app LIMIT 1;
    IF NOT COALESCE(v_in_plan, false) THEN
      IF v_trial.expires_at IS NOT NULL
         AND v_trial.expires_at > (now() - (v_app_grace_days || ' days')::interval) THEN
        RETURN 'grace';
      END IF;
      RETURN 'expired_trial';
    END IF;
  END IF;
  IF v_org.subscription_status = 'past_due' THEN RETURN 'grace'; END IF;
  RETURN 'active';
END;
$function$;

INSERT INTO public.platform_settings (setting_key, setting_value, setting_type, description, is_secret)
VALUES ('allow_open_addon_trials','true','boolean',
  'When true, any installable app can offer a free trial even if no pricing rule exists (Odoo-style open marketplace). When false, apps with no pricing rule become "Request access" instead of trial-eligible.', false)
ON CONFLICT (setting_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.is_subscription_active(_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT public.subscription_active_for_org(_org_id) $$;
CREATE OR REPLACE FUNCTION public.is_org_subscription_active(_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT public.subscription_active_for_org(_org_id) $$;
CREATE OR REPLACE FUNCTION public.check_org_subscription_active(p_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT public.subscription_active_for_org(p_org_id) $$;
CREATE OR REPLACE FUNCTION public.rls_check_org_subscription_active(p_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT public.subscription_active_for_org(p_org_id) $$;
CREATE OR REPLACE FUNCTION public.check_subscription_expired(_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT NOT public.subscription_active_for_org(_org_id) $$;
CREATE OR REPLACE FUNCTION public.check_org_feature_access(_org_id uuid, _feature_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT public.check_org_feature_access_v2(_org_id, _feature_key) $$;
CREATE OR REPLACE FUNCTION public.rls_check_feature_access(p_org_id uuid, p_feature_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT public.check_org_feature_access_v2(p_org_id, p_feature_key) $$;

COMMENT ON FUNCTION public.is_subscription_active(uuid) IS 'Deprecated wrapper. Use subscription_active_for_org.';
COMMENT ON FUNCTION public.is_org_subscription_active(uuid) IS 'Deprecated wrapper. Use subscription_active_for_org.';
COMMENT ON FUNCTION public.check_org_subscription_active(uuid) IS 'Deprecated wrapper. Use subscription_active_for_org.';
COMMENT ON FUNCTION public.rls_check_org_subscription_active(uuid) IS 'Deprecated wrapper. Use subscription_active_for_org.';
COMMENT ON FUNCTION public.check_subscription_expired(uuid) IS 'Deprecated. Use NOT subscription_active_for_org.';
COMMENT ON FUNCTION public.check_org_feature_access(uuid, text) IS 'Deprecated wrapper. Use check_org_feature_access_v2.';
COMMENT ON FUNCTION public.rls_check_feature_access(uuid, text) IS 'Deprecated wrapper. Use check_org_feature_access_v2.';

CREATE OR REPLACE FUNCTION public.get_commercial_timeline(
  _org_id uuid, _limit int DEFAULT 100, _before timestamptz DEFAULT NULL
) RETURNS TABLE(
  id uuid, event_type text, app_id text, plan_id uuid,
  actor_id uuid, actor_email text, payload jsonb, created_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT cal.id, cal.event_type, cal.app_id, cal.plan_id, cal.actor_id,
         u.email AS actor_email, cal.payload, cal.created_at
    FROM public.commercial_audit_logs cal
    LEFT JOIN auth.users u ON u.id = cal.actor_id
   WHERE cal.org_id = _org_id
     AND (_before IS NULL OR cal.created_at < _before)
     AND (
       EXISTS (SELECT 1 FROM public.user_roles
                WHERE user_id = auth.uid() AND role = 'super_admin' AND is_active = true)
       OR EXISTS (SELECT 1 FROM public.user_roles
                   WHERE user_id = auth.uid() AND organization_id = _org_id
                     AND role IN ('owner','admin') AND is_active = true)
     )
   ORDER BY cal.created_at DESC
   LIMIT GREATEST(1, LEAST(_limit, 500));
$$;

COMMENT ON FUNCTION public.get_commercial_timeline(uuid, int, timestamptz) IS
  'Returns commercial event timeline for an org. Platform admins and org owners/admins only.';

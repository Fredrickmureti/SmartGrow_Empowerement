CREATE OR REPLACE FUNCTION public.expire_app_trials() RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0; r RECORD;
BEGIN
  FOR r IN UPDATE public.app_trial_status SET status = 'expired' WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= now() RETURNING organization_id, app_id LOOP
    v_count := v_count + 1;
    BEGIN PERFORM public.log_commercial_event(r.organization_id, 'app_trial_expired', r.app_id, NULL, jsonb_build_object('source','expire_app_trials_cron')); EXCEPTION WHEN OTHERS THEN NULL; END;
  END LOOP;
  RETURN v_count;
END; $$;

DO $$ BEGIN PERFORM cron.unschedule('expire-app-trials'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
SELECT cron.schedule('expire-app-trials','7 * * * *', $$ SELECT public.expire_app_trials(); $$);

CREATE OR REPLACE FUNCTION public.app_state_for_org(_org_id uuid, _app_id text) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org RECORD; v_installed RECORD; v_trial RECORD; v_in_plan boolean;
  v_grace_days constant int := 7; v_app_grace_days constant int := 3;
  v_trial_active boolean := false; v_trial_expired boolean := false;
BEGIN
  IF _org_id IS NULL OR _app_id IS NULL OR _app_id = '' THEN RETURN 'not_installed'; END IF;
  IF _app_id = 'hr' THEN RETURN 'not_installed'; END IF;
  SELECT subscription_status, subscription_ends_at, trial_ends_at, is_suspended, subscription_plan_id AS plan_id INTO v_org FROM public.organizations WHERE id = _org_id;
  IF NOT FOUND THEN RETURN 'not_installed'; END IF;
  IF COALESCE(v_org.is_suspended, false) THEN RETURN 'suspended'; END IF;
  SELECT app_id, lifecycle_state, is_active INTO v_installed FROM public.organization_installed_apps WHERE organization_id = _org_id AND app_id = _app_id LIMIT 1;
  IF NOT FOUND OR COALESCE(v_installed.is_active, true) = false THEN RETURN 'not_installed'; END IF;
  SELECT status, expires_at INTO v_trial FROM public.app_trial_status WHERE organization_id = _org_id AND app_id = _app_id ORDER BY created_at DESC LIMIT 1;
  v_trial_active  := v_trial.status = 'active' AND (v_trial.expires_at IS NULL OR v_trial.expires_at > now());
  v_trial_expired := v_trial.status IN ('expired','cancelled') OR (v_trial.status = 'active' AND v_trial.expires_at IS NOT NULL AND v_trial.expires_at <= now());
  IF v_trial_active THEN RETURN 'trial'; END IF;
  IF v_org.subscription_status = 'expired' OR (v_org.subscription_ends_at IS NOT NULL AND v_org.subscription_ends_at <= now()) THEN
    IF v_org.subscription_ends_at IS NOT NULL AND v_org.subscription_ends_at > (now() - (v_grace_days || ' days')::interval) THEN RETURN 'grace'; END IF;
    RETURN 'read_only';
  END IF;
  IF v_trial_expired THEN
    SELECT COALESCE(is_enabled, false) INTO v_in_plan FROM public.plan_app_access WHERE plan_id = v_org.plan_id AND app_id = _app_id LIMIT 1;
    IF NOT COALESCE(v_in_plan, false) THEN
      IF v_trial.expires_at IS NOT NULL AND v_trial.expires_at > (now() - (v_app_grace_days || ' days')::interval) THEN RETURN 'grace'; END IF;
      RETURN 'expired_trial';
    END IF;
  END IF;
  IF v_org.subscription_status = 'past_due' THEN RETURN 'grace'; END IF;
  RETURN 'active';
END; $$;
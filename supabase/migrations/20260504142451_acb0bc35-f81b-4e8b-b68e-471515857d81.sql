CREATE OR REPLACE FUNCTION public.install_app(p_org_id uuid, p_app_id text)
RETURNS public.organization_installed_apps
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_result public.organization_installed_apps;
  v_use_per_user boolean := false; v_max_apps int; v_current_count int; v_plan_name text;
  v_already_installed boolean; v_business_count int; v_plan jsonb; v_entry jsonb;
  v_blocked text[]; v_blocked_names text; v_plan_id uuid;
  v_started_trials text[] := ARRAY[]::text[]; v_inserted_apps text[] := ARRAY[]::text[];
  v_app_id text; v_user uuid := auth.uid(); v_attempt_id uuid; v_max_depth int;
  v_existing_trial public.app_trial_status; v_can_trial boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = v_user AND organization_id = p_org_id AND role IN ('owner','admin') AND is_active = true) THEN
    RAISE EXCEPTION 'Unauthorized: you must be an admin or owner of this organization';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_org_id::text || ':' || p_app_id));

  IF p_app_id IN ('hr','pos','employees','time-off','attendance','payroll','recruitment','sales','purchases','inventory','finance') THEN
    SELECT COUNT(*) INTO v_business_count FROM public.businesses WHERE organization_id = p_org_id AND is_active = true;
    IF v_business_count = 0 THEN
      RAISE EXCEPTION 'SETUP_REQUIRED: % requires at least one active Company. Create a Company first, then install this app.', p_app_id USING ERRCODE='P0001', HINT='no_business';
    END IF;
  END IF;

  SELECT (setting_value::boolean) INTO v_use_per_user FROM public.platform_settings WHERE setting_key='use_per_user_billing' LIMIT 1;
  v_use_per_user := COALESCE(v_use_per_user, false);

  SELECT EXISTS (SELECT 1 FROM public.organization_installed_apps WHERE organization_id=p_org_id AND app_id=p_app_id AND is_active=true) INTO v_already_installed;

  IF v_use_per_user AND NOT v_already_installed AND p_app_id <> 'platform' THEN
    SELECT psp.max_installed_apps, psp.name INTO v_max_apps, v_plan_name FROM public.organizations o JOIN public.platform_subscription_plans psp ON psp.id = o.subscription_plan_id WHERE o.id = p_org_id;
    IF v_max_apps IS NOT NULL THEN
      SELECT COUNT(*) INTO v_current_count FROM public.organization_installed_apps WHERE organization_id=p_org_id AND is_active=true AND app_id<>'platform';
      IF v_current_count >= v_max_apps THEN
        RAISE EXCEPTION 'SETUP_REQUIRED: Your % plan includes % app(s). Upgrade to install more.', COALESCE(v_plan_name,'current'), v_max_apps USING ERRCODE='P0001';
      END IF;
    END IF;
  END IF;

  v_plan := public.resolve_install_plan(p_org_id, p_app_id);
  v_blocked := ARRAY(SELECT jsonb_array_elements_text(v_plan->'blocked_apps'));

  SELECT MAX((e->>'depth')::int) INTO v_max_depth FROM jsonb_array_elements(v_plan->'entries') e;
  IF v_max_depth IS NOT NULL AND v_max_depth >= 6 THEN
    RAISE WARNING 'install_app: dependency depth % reached cap for app % — graph may be truncated', v_max_depth, p_app_id;
  END IF;

  INSERT INTO public.app_install_attempts (organization_id, user_id, requested_app_id, plan_snapshot, outcome)
  VALUES (p_org_id, v_user, p_app_id, v_plan, 'pending') RETURNING id INTO v_attempt_id;

  IF array_length(v_blocked, 1) IS NOT NULL THEN
    SELECT string_agg(COALESCE(pa.name, b), ', ') INTO v_blocked_names FROM unnest(v_blocked) b LEFT JOIN public.platform_apps pa ON pa.id = b;
    UPDATE public.app_install_attempts SET outcome='blocked', error_code='ENTITLEMENT_REQUIRED', error_message=v_blocked_names WHERE id=v_attempt_id;
    RAISE EXCEPTION 'ENTITLEMENT_REQUIRED: The following app(s) are not included in your plan and cannot be trialled: %. Upgrade your plan to install %.',
      v_blocked_names, COALESCE((SELECT name FROM public.platform_apps WHERE id=p_app_id), p_app_id) USING ERRCODE='P0001', HINT='not_entitled';
  END IF;

  SELECT subscription_plan_id INTO v_plan_id FROM public.organizations WHERE id=p_org_id;

  FOR v_entry IN SELECT jsonb_array_elements(v_plan->'entries')
  LOOP
    v_app_id := v_entry->>'app_id';
    IF v_entry->>'action' IN ('already_installed','skip_optional') THEN CONTINUE; END IF;

    IF v_entry->>'action' = 'install_will_start_trial' THEN
      SELECT * INTO v_existing_trial FROM public.app_trial_status WHERE organization_id = p_org_id AND app_id = v_app_id ORDER BY created_at DESC LIMIT 1;
      IF FOUND AND v_existing_trial.status <> 'active' THEN
        v_can_trial := public.is_app_trialable_for(p_org_id, v_app_id);
        IF NOT v_can_trial THEN
          UPDATE public.app_install_attempts SET outcome='blocked', error_code='TRIAL_NOT_ALLOWED', error_message=format('Trial cooldown for %s has not elapsed', v_app_id) WHERE id=v_attempt_id;
          RAISE EXCEPTION 'TRIAL_NOT_ALLOWED: The trial for % has already been used. The cooldown period has not yet elapsed.',
            COALESCE((SELECT name FROM public.platform_apps WHERE id=v_app_id), v_app_id) USING ERRCODE='P0001', HINT='trial_cooldown';
        END IF;
      END IF;

      INSERT INTO public.app_trial_status (organization_id, app_id, status, started_at, expires_at)
      VALUES (p_org_id, v_app_id, 'active', now(), now() + (COALESCE((v_entry->>'trial_days')::int, 14) || ' days')::interval)
      ON CONFLICT (organization_id, app_id) DO UPDATE SET status='active', started_at=EXCLUDED.started_at, expires_at=EXCLUDED.expires_at;
      v_started_trials := array_append(v_started_trials, v_app_id);
    END IF;

    INSERT INTO public.organization_installed_apps (organization_id, app_id, installed_by, is_active, lifecycle_state)
    VALUES (p_org_id, v_app_id, v_user, true, COALESCE(v_entry->>'lifecycle_state', 'active')::public.app_lifecycle_state)
    ON CONFLICT (organization_id, app_id) DO UPDATE SET is_active=true, lifecycle_state=COALESCE(EXCLUDED.lifecycle_state, public.organization_installed_apps.lifecycle_state), updated_at=now();
    v_inserted_apps := array_append(v_inserted_apps, v_app_id);

    PERFORM public.seed_app_data(p_org_id, v_app_id);
    PERFORM public.log_commercial_event(p_org_id, 'app_installed', v_app_id, v_plan_id,
      jsonb_build_object('requested_app', p_app_id, 'action', v_entry->>'action', 'state', v_entry->>'lifecycle_state', 'depth', v_entry->>'depth', 'dependency_kind', v_entry->>'dependency_kind'));
  END LOOP;

  UPDATE public.app_install_attempts SET outcome='success' WHERE id=v_attempt_id;
  SELECT * INTO v_result FROM public.organization_installed_apps WHERE organization_id=p_org_id AND app_id=p_app_id;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.uninstall_app(p_org_id uuid, p_app_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND organization_id = p_org_id AND role IN ('owner','admin') AND is_active = true) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(p_org_id::text || ':' || p_app_id));
  UPDATE public.organization_installed_apps SET is_active = false, lifecycle_state = 'uninstalled_readonly'::public.app_lifecycle_state, updated_at = now()
   WHERE organization_id = p_org_id AND app_id = p_app_id;
  PERFORM public.log_commercial_event(p_org_id, 'app_uninstalled', p_app_id, NULL, '{}'::jsonb);
  RETURN true;
END; $$;

CREATE OR REPLACE FUNCTION public.record_install_attempt_failure(
  p_org_id uuid, p_user_id uuid, p_requested_app_id text, p_error_code text, p_error_message text, p_plan_snapshot jsonb DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_caller uuid;
BEGIN
  v_caller := COALESCE(auth.uid(), p_user_id);
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = v_caller AND organization_id = p_org_id AND role IN ('owner','admin') AND is_active = true) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  INSERT INTO public.app_install_attempts (organization_id, user_id, requested_app_id, plan_snapshot, outcome, error_code, error_message)
  VALUES (p_org_id, v_caller, p_requested_app_id, COALESCE(p_plan_snapshot, '{}'::jsonb), 'error',
          LEFT(COALESCE(p_error_code, 'UNKNOWN'), 64), LEFT(COALESCE(p_error_message, ''), 4000))
  RETURNING id INTO v_id;
  RETURN v_id;
END; $$;

GRANT EXECUTE ON FUNCTION public.record_install_attempt_failure(uuid,uuid,text,text,text,jsonb) TO authenticated;
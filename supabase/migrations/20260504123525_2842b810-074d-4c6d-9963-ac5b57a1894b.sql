-- =====================================================================
-- App installation lifecycle hardening
-- =====================================================================
-- Goals:
--   1. Make install_app atomic — partial trials never persist on failure.
--   2. Replace implicit "trialable = has pricing rule" with an explicit
--      app_trial_policy table that platform admins control.
--   3. Allow re-trial after a configurable cooldown.
--   4. Lock start_app_trial down so trials are only ever started inside
--      install_app — eliminates the orphan-trial bug class.
--   5. Add an audit table so platform admins can see install-attempt
--      outcomes and the resolved dependency plan.
--   6. Reconcile existing orphan trials produced by the old code.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. app_trial_policy — explicit per-app commercial policy
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_trial_policy (
  app_id text PRIMARY KEY REFERENCES public.platform_apps(id) ON DELETE CASCADE,
  is_trialable boolean NOT NULL DEFAULT true,
  default_trial_days integer NOT NULL DEFAULT 14 CHECK (default_trial_days BETWEEN 0 AND 365),
  auto_trial_on_dep_install boolean NOT NULL DEFAULT true,
  allow_retrial boolean NOT NULL DEFAULT false,
  retrial_cooldown_days integer NOT NULL DEFAULT 90 CHECK (retrial_cooldown_days BETWEEN 0 AND 3650),
  bundled_with_parent_trial boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.app_trial_policy ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read app_trial_policy" ON public.app_trial_policy;
CREATE POLICY "Anyone can read app_trial_policy"
  ON public.app_trial_policy FOR SELECT TO authenticated, anon USING (true);

DROP POLICY IF EXISTS "Platform admins manage app_trial_policy" ON public.app_trial_policy;
CREATE POLICY "Platform admins manage app_trial_policy"
  ON public.app_trial_policy FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

-- Seed: every platform app gets a default policy. Apps with an active
-- pricing rule are trialable; apps without are not (admin can flip).
INSERT INTO public.app_trial_policy (app_id, is_trialable, default_trial_days)
SELECT pa.id,
       EXISTS (SELECT 1 FROM public.app_pricing_rules apr
                WHERE apr.app_id = pa.id AND apr.is_active = true),
       COALESCE(
         (SELECT NULLIF(setting_value,'')::int
            FROM public.platform_settings WHERE setting_key='default_trial_days' LIMIT 1),
         14
       )
  FROM public.platform_apps pa
ON CONFLICT (app_id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. app_install_attempts — audit / observability
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_install_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid,
  requested_app_id text NOT NULL,
  plan_snapshot jsonb,
  outcome text NOT NULL CHECK (outcome IN ('success','blocked','error')),
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_install_attempts_org_created
  ON public.app_install_attempts(organization_id, created_at DESC);

ALTER TABLE public.app_install_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org admins see own install attempts" ON public.app_install_attempts;
CREATE POLICY "Org admins see own install attempts"
  ON public.app_install_attempts FOR SELECT TO authenticated
  USING (
    public.is_platform_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
       WHERE ur.user_id = auth.uid()
         AND ur.organization_id = app_install_attempts.organization_id
         AND ur.role IN ('owner','admin')
         AND ur.is_active = true
    )
  );

-- Only SECURITY DEFINER functions write rows; no direct INSERT policy.

-- ---------------------------------------------------------------------
-- 3. is_app_trialable_for(org, app) — policy + retrial-cooldown aware
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_app_trialable_for(p_org_id uuid, p_app_id text)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_policy public.app_trial_policy;
  v_last_trial public.app_trial_status;
BEGIN
  SELECT * INTO v_policy FROM public.app_trial_policy WHERE app_id = p_app_id;
  IF NOT FOUND OR NOT v_policy.is_trialable THEN
    RETURN false;
  END IF;

  SELECT * INTO v_last_trial
    FROM public.app_trial_status
   WHERE organization_id = p_org_id AND app_id = p_app_id
   ORDER BY created_at DESC LIMIT 1;

  IF NOT FOUND THEN
    RETURN true; -- never trialled
  END IF;

  IF v_last_trial.status = 'active' THEN
    RETURN true; -- ongoing trial counts as "trialable" (already covered)
  END IF;

  IF NOT v_policy.allow_retrial THEN
    RETURN false;
  END IF;

  -- Re-trial allowed if cooldown has elapsed since the trial ended.
  RETURN COALESCE(v_last_trial.expires_at, v_last_trial.created_at)
         + (v_policy.retrial_cooldown_days || ' days')::interval <= now();
END;
$$;

REVOKE ALL ON FUNCTION public.is_app_trialable_for(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_app_trialable_for(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------
-- 4. resolve_install_plan — policy-driven, exposes billing impact
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_install_plan(p_org_id uuid, p_app_id text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_plan_id uuid;
  v_entries jsonb := '[]'::jsonb;
  v_billing jsonb := '[]'::jsonb;
  v_blocked text[] := ARRAY[]::text[];
  v_will_install text[] := ARRAY[]::text[];
  v_will_trial text[] := ARRAY[]::text[];
  r RECORD;
  v_in_plan boolean;
  v_overridden boolean;
  v_on_trial boolean;
  v_trialable boolean;
  v_already boolean;
  v_action text;
  v_state text;
  v_policy public.app_trial_policy;
  v_trial_days int;
  v_price RECORD;
BEGIN
  SELECT subscription_plan_id INTO v_plan_id
    FROM public.organizations WHERE id = p_org_id;

  FOR r IN
    WITH RECURSIVE deps AS (
      SELECT depends_on_app_id AS app_id, dependency_kind, 1 AS depth
        FROM public.app_dependencies WHERE app_id = p_app_id
      UNION
      SELECT ad.depends_on_app_id, ad.dependency_kind, d.depth + 1
        FROM public.app_dependencies ad
        JOIN deps d ON d.app_id = ad.app_id
       WHERE d.depth < 6
    ),
    collapsed AS (
      SELECT app_id,
             CASE WHEN bool_or(dependency_kind='bundled') THEN 'bundled'
                  WHEN bool_or(dependency_kind='technical') THEN 'technical'
                  ELSE 'optional' END AS dependency_kind,
             MAX(depth) AS depth
        FROM deps GROUP BY app_id
    )
    SELECT app_id, dependency_kind, depth FROM collapsed
    UNION ALL
    SELECT p_app_id, 'self'::text, 0
    ORDER BY depth DESC
  LOOP
    IF r.app_id = 'platform' THEN CONTINUE; END IF;

    SELECT EXISTS (SELECT 1 FROM public.organization_installed_apps
                    WHERE organization_id=p_org_id AND app_id=r.app_id AND is_active=true)
      INTO v_already;
    SELECT EXISTS (SELECT 1 FROM public.plan_app_access
                    WHERE plan_id=v_plan_id AND app_id=r.app_id AND is_enabled=true)
      INTO v_in_plan;
    SELECT EXISTS (SELECT 1 FROM public.org_entitlement_overrides
                    WHERE organization_id=p_org_id AND override_type='app' AND key=r.app_id
                      AND is_active=true AND (expires_at IS NULL OR expires_at > now()))
      INTO v_overridden;
    SELECT EXISTS (SELECT 1 FROM public.app_trial_status
                    WHERE organization_id=p_org_id AND app_id=r.app_id
                      AND status='active' AND expires_at > now())
      INTO v_on_trial;

    v_trialable := public.is_app_trialable_for(p_org_id, r.app_id);
    SELECT * INTO v_policy FROM public.app_trial_policy WHERE app_id=r.app_id;
    v_trial_days := NULL;

    IF v_already THEN
      v_action := 'already_installed'; v_state := NULL;
    ELSIF v_in_plan THEN
      v_action := 'install_in_plan'; v_state := 'active';
    ELSIF v_overridden THEN
      v_action := 'install_override'; v_state := 'active';
    ELSIF v_on_trial THEN
      v_action := 'install_existing_trial'; v_state := 'trial';
    ELSIF r.dependency_kind = 'bundled' THEN
      v_action := 'install_bundled'; v_state := 'active';
    ELSIF r.dependency_kind = 'optional' THEN
      v_action := 'skip_optional'; v_state := NULL;
    ELSIF v_trialable AND (
      r.dependency_kind = 'self'   -- requested app: always allowed if trialable
      OR COALESCE(v_policy.auto_trial_on_dep_install, true)
    ) THEN
      v_action := 'install_will_start_trial'; v_state := 'trial';
      v_trial_days := COALESCE(v_policy.default_trial_days, 14);
      v_will_trial := array_append(v_will_trial, r.app_id);
    ELSE
      v_action := 'blocked'; v_state := NULL;
      v_blocked := array_append(v_blocked, r.app_id);
    END IF;

    IF v_action LIKE 'install_%' THEN
      v_will_install := array_append(v_will_install, r.app_id);
    END IF;

    -- Billing impact line per app (single-currency snapshot from active rule)
    SELECT app_id, monthly_price, currency
      INTO v_price FROM public.app_pricing_rules
     WHERE app_id = r.app_id AND is_active = true LIMIT 1;

    v_entries := v_entries || jsonb_build_object(
      'app_id',          r.app_id,
      'dependency_kind', r.dependency_kind,
      'depth',           r.depth,
      'action',          v_action,
      'lifecycle_state', v_state,
      'trial_days',      v_trial_days,
      'in_plan',         v_in_plan,
      'overridden',      v_overridden,
      'on_trial',        v_on_trial,
      'trialable',       v_trialable,
      'already_installed', v_already,
      'monthly_price',   COALESCE(v_price.monthly_price, 0),
      'currency',        v_price.currency,
      'bundled',         COALESCE(v_policy.bundled_with_parent_trial, false)
    );

    IF v_action LIKE 'install_%' AND v_action <> 'already_installed' THEN
      v_billing := v_billing || jsonb_build_object(
        'app_id',   r.app_id,
        'kind',     CASE
                      WHEN v_action IN ('install_in_plan','install_override','install_existing_trial') THEN 'in_plan'
                      WHEN v_action IN ('install_will_start_trial','install_bundled') THEN 'free_trial'
                      ELSE 'addon' END,
        'amount',   COALESCE(v_price.monthly_price, 0),
        'currency', COALESCE(v_price.currency, 'USD'),
        'trial_days', v_trial_days
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'app_id',                p_app_id,
    'entries',               v_entries,
    'will_install',          v_will_install,
    'will_start_trial',      v_will_trial,
    'blocked_apps',          v_blocked,
    'can_install',           array_length(v_blocked,1) IS NULL,
    'all_dependencies',      (SELECT COALESCE(array_agg(value->>'app_id'), ARRAY[]::text[])
                                FROM jsonb_array_elements(v_entries)),
    'will_be_installed',     v_will_install,
    'missing_entitlements',  v_blocked,
    'billing_impact',        v_billing
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_install_plan(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_install_plan(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------
-- 5. Atomic install_app (drop + recreate)
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.install_app(uuid, text);

CREATE OR REPLACE FUNCTION public.install_app(p_org_id uuid, p_app_id text)
RETURNS public.organization_installed_apps
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_result public.organization_installed_apps;
  v_use_per_user boolean := false;
  v_max_apps int;
  v_current_count int;
  v_plan_name text;
  v_already_installed boolean;
  v_business_count int;
  v_plan jsonb;
  v_entry jsonb;
  v_blocked text[];
  v_blocked_names text;
  v_plan_id uuid;
  v_started_trials text[] := ARRAY[]::text[];
  v_inserted_apps text[] := ARRAY[]::text[];
  v_app_id text;
  v_user uuid := auth.uid();
  v_attempt_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = v_user
       AND organization_id = p_org_id
       AND role IN ('owner','admin')
       AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Unauthorized: you must be an admin or owner of this organization';
  END IF;

  IF p_app_id IN (
    'hr','pos',
    'employees','time-off','attendance','payroll','recruitment',
    'sales','purchases','inventory','finance'
  ) THEN
    SELECT COUNT(*) INTO v_business_count
      FROM public.businesses
     WHERE organization_id = p_org_id AND is_active = true;
    IF v_business_count = 0 THEN
      RAISE EXCEPTION 'SETUP_REQUIRED: % requires at least one active Company. Create a Company first, then install this app.',
        p_app_id USING ERRCODE='P0001', HINT='no_business';
    END IF;
  END IF;

  SELECT (setting_value::boolean) INTO v_use_per_user
    FROM public.platform_settings WHERE setting_key='use_per_user_billing' LIMIT 1;
  v_use_per_user := COALESCE(v_use_per_user, false);

  SELECT EXISTS (SELECT 1 FROM public.organization_installed_apps
                  WHERE organization_id=p_org_id AND app_id=p_app_id AND is_active=true)
    INTO v_already_installed;

  IF v_use_per_user AND NOT v_already_installed AND p_app_id <> 'platform' THEN
    SELECT psp.max_installed_apps, psp.name INTO v_max_apps, v_plan_name
      FROM public.organizations o
      JOIN public.platform_subscription_plans psp ON psp.id = o.subscription_plan_id
     WHERE o.id = p_org_id;
    IF v_max_apps IS NOT NULL THEN
      SELECT COUNT(*) INTO v_current_count
        FROM public.organization_installed_apps
       WHERE organization_id=p_org_id AND is_active=true AND app_id<>'platform';
      IF v_current_count >= v_max_apps THEN
        RAISE EXCEPTION 'SETUP_REQUIRED: Your % plan includes % app(s). Upgrade to install more.',
          COALESCE(v_plan_name,'current'), v_max_apps USING ERRCODE='P0001';
      END IF;
    END IF;
  END IF;

  v_plan := public.resolve_install_plan(p_org_id, p_app_id);
  v_blocked := ARRAY(SELECT jsonb_array_elements_text(v_plan->'blocked_apps'));

  -- Pre-record attempt with snapshot; outcome updated below.
  INSERT INTO public.app_install_attempts
    (organization_id, user_id, requested_app_id, plan_snapshot, outcome)
  VALUES (p_org_id, v_user, p_app_id, v_plan, 'error')
  RETURNING id INTO v_attempt_id;

  IF array_length(v_blocked, 1) IS NOT NULL THEN
    SELECT string_agg(COALESCE(pa.name, b), ', ')
      INTO v_blocked_names
      FROM unnest(v_blocked) b
      LEFT JOIN public.platform_apps pa ON pa.id = b;
    UPDATE public.app_install_attempts
       SET outcome='blocked',
           error_code='ENTITLEMENT_REQUIRED',
           error_message=v_blocked_names
     WHERE id=v_attempt_id;
    RAISE EXCEPTION
      'ENTITLEMENT_REQUIRED: The following app(s) are not included in your plan and cannot be trialled: %. Upgrade your plan to install %.',
      v_blocked_names, COALESCE((SELECT name FROM public.platform_apps WHERE id=p_app_id), p_app_id)
      USING ERRCODE='P0001', HINT='not_entitled';
  END IF;

  SELECT subscription_plan_id INTO v_plan_id FROM public.organizations WHERE id=p_org_id;

  -- =================================================================
  -- ATOMIC INSTALL — entire loop runs in this function's tx. Any error
  -- raised mid-loop (constraint, seed failure) rolls back everything,
  -- including app_trial_status inserts and organization_installed_apps
  -- inserts. Postgres handles this naturally inside a single function.
  -- We additionally track inserted ids so that if we ever split this
  -- across savepoints in the future, we can do explicit cleanup.
  -- =================================================================
  FOR v_entry IN SELECT jsonb_array_elements(v_plan->'entries')
  LOOP
    v_app_id := v_entry->>'app_id';
    IF v_entry->>'action' IN ('already_installed','skip_optional') THEN CONTINUE; END IF;

    IF v_entry->>'action' = 'install_will_start_trial' THEN
      INSERT INTO public.app_trial_status
        (organization_id, app_id, status, started_at, expires_at)
      VALUES (
        p_org_id, v_app_id, 'active', now(),
        now() + (COALESCE((v_entry->>'trial_days')::int, 14) || ' days')::interval
      )
      ON CONFLICT (organization_id, app_id) DO UPDATE
        SET status='active',
            started_at=now(),
            expires_at=now() + (COALESCE((EXCLUDED.expires_at - EXCLUDED.started_at), interval '14 days'));
      v_started_trials := array_append(v_started_trials, v_app_id);
    END IF;

    INSERT INTO public.organization_installed_apps
      (organization_id, app_id, installed_by, is_active, lifecycle_state)
    VALUES (
      p_org_id, v_app_id, v_user, true,
      COALESCE(v_entry->>'lifecycle_state', 'active')::public.app_lifecycle_state
    )
    ON CONFLICT (organization_id, app_id) DO UPDATE
      SET is_active=true,
          lifecycle_state=COALESCE(EXCLUDED.lifecycle_state, public.organization_installed_apps.lifecycle_state),
          updated_at=now();
    v_inserted_apps := array_append(v_inserted_apps, v_app_id);

    PERFORM public.seed_app_data(p_org_id, v_app_id);
    PERFORM public.log_commercial_event(
      p_org_id, 'app_installed', v_app_id, v_plan_id,
      jsonb_build_object(
        'requested_app',   p_app_id,
        'action',          v_entry->>'action',
        'state',           v_entry->>'lifecycle_state',
        'depth',           v_entry->>'depth',
        'dependency_kind', v_entry->>'dependency_kind'
      )
    );
  END LOOP;

  UPDATE public.app_install_attempts SET outcome='success' WHERE id=v_attempt_id;

  SELECT * INTO v_result FROM public.organization_installed_apps
   WHERE organization_id=p_org_id AND app_id=p_app_id;
  RETURN v_result;

EXCEPTION
  WHEN OTHERS THEN
    -- Postgres rolls back the entire function's work automatically since
    -- this function runs in its own implicit subtransaction context only
    -- when called from a parent transaction. To be safe across all callers
    -- (RPC dispatches each call in its own tx), we record the error and
    -- re-raise so the caller observes a clean failure.
    BEGIN
      UPDATE public.app_install_attempts
         SET outcome='error',
             error_code=COALESCE(SQLSTATE, 'UNKNOWN'),
             error_message=SQLERRM
       WHERE id=v_attempt_id;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RAISE;
END;
$function$;

REVOKE ALL ON FUNCTION public.install_app(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.install_app(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------
-- 6. Lock down start_app_trial — internal use only
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.start_app_trial(uuid, text, integer) FROM PUBLIC, authenticated, anon;
-- service_role retains EXECUTE for ops; install_app calls it as definer.

-- ---------------------------------------------------------------------
-- 7. Orphan reconciliation — clean up partial installs from old code
-- ---------------------------------------------------------------------
DO $orphan$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT ats.organization_id, ats.app_id, ats.started_at
      FROM public.app_trial_status ats
     WHERE ats.status='active'
       AND ats.expires_at > now()
       AND NOT EXISTS (
         SELECT 1 FROM public.organization_installed_apps oia
          WHERE oia.organization_id=ats.organization_id
            AND oia.app_id=ats.app_id
            AND oia.is_active=true
       )
  LOOP
    IF r.started_at > now() - interval '24 hours' THEN
      -- Recent: complete the install
      BEGIN
        INSERT INTO public.organization_installed_apps
          (organization_id, app_id, installed_by, is_active, lifecycle_state)
        VALUES (r.organization_id, r.app_id, NULL, true, 'trial'::public.app_lifecycle_state)
        ON CONFLICT (organization_id, app_id) DO UPDATE
          SET is_active=true, lifecycle_state='trial', updated_at=now();
        BEGIN
          PERFORM public.seed_app_data(r.organization_id, r.app_id);
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'orphan reconcile: seed failed for % %: %', r.organization_id, r.app_id, SQLERRM;
        END;
        PERFORM public.log_commercial_event(
          r.organization_id, 'orphan_trial_reconciled_install', r.app_id, NULL,
          jsonb_build_object('reason','recent_orphan_completed')
        );
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'orphan reconcile failed for % %: %', r.organization_id, r.app_id, SQLERRM;
      END;
    ELSE
      -- Old: cancel the trial
      UPDATE public.app_trial_status
         SET status='cancelled', updated_at=now()
       WHERE organization_id=r.organization_id AND app_id=r.app_id AND status='active';
      PERFORM public.log_commercial_event(
        r.organization_id, 'orphan_trial_reconciled_cancel', r.app_id, NULL,
        jsonb_build_object('reason','old_orphan_cancelled')
      );
    END IF;
  END LOOP;
END;
$orphan$;

-- ---------------------------------------------------------------------
-- 8. updated_at trigger on app_trial_policy
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS update_app_trial_policy_updated_at ON public.app_trial_policy;
CREATE TRIGGER update_app_trial_policy_updated_at
  BEFORE UPDATE ON public.app_trial_policy
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
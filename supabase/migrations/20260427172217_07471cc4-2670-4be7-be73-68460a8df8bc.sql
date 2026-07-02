
-- =============================================================================
-- Phase A — Commercial RPC fixes (B1, B2, B3) + commercial audit ledger
-- Scope: commercial control surface ONLY. No finance/HR/POS/inventory tables
-- or business logic are touched.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Commercial audit log (single timeline for plan/install/trial/override events)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.commercial_audit_logs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  actor_id     uuid,                       -- auth.uid() at time of event (nullable for system jobs)
  event_type   text NOT NULL,              -- 'app_installed','app_uninstalled','trial_started',
                                           -- 'trial_expired','trial_converted','plan_changed',
                                           -- 'override_granted','override_revoked','suspended',
                                           -- 'reactivated'
  app_id       text,
  plan_id      uuid,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_commercial_audit_logs_org_created
  ON public.commercial_audit_logs (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commercial_audit_logs_event
  ON public.commercial_audit_logs (event_type, created_at DESC);

ALTER TABLE public.commercial_audit_logs ENABLE ROW LEVEL SECURITY;

-- Tenants (owners/admins) can read their own commercial timeline.
CREATE POLICY "org_members_read_commercial_audit"
ON public.commercial_audit_logs FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = auth.uid()
       AND ur.organization_id = commercial_audit_logs.org_id
       AND ur.is_active = true
       AND ur.role IN ('owner','admin')
  )
);

-- Platform admins can read everything.
CREATE POLICY "platform_admin_read_commercial_audit"
ON public.commercial_audit_logs FOR SELECT
USING (public.is_platform_admin(auth.uid()));

-- Inserts only via SECURITY DEFINER helpers — no direct client writes.
-- (No INSERT policy => default deny; SECURITY DEFINER functions bypass RLS.)

-- -----------------------------------------------------------------------------
-- 2. Helper to write audit rows (SECURITY DEFINER)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_commercial_event(
  p_org_id     uuid,
  p_event_type text,
  p_app_id     text DEFAULT NULL,
  p_plan_id    uuid DEFAULT NULL,
  p_payload    jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.commercial_audit_logs (org_id, actor_id, event_type, app_id, plan_id, payload)
  VALUES (p_org_id, auth.uid(), p_event_type, p_app_id, p_plan_id, COALESCE(p_payload,'{}'::jsonb))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.log_commercial_event(uuid,text,text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_commercial_event(uuid,text,text,uuid,jsonb) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. B1 fix — disable_expired_app_trials
--    Use the real tables (organization_installed_apps, organizations,
--    plan_app_access). Flip lifecycle_state to 'trial_expired' and is_active=false
--    only when no plan inclusion and no active override exists.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.disable_expired_app_trials()
RETURNS TABLE(expired_count integer, disabled_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expired  integer := 0;
  v_disabled integer := 0;
BEGIN
  -- 1) Move active trials past their deadline to 'expired'.
  WITH newly_expired AS (
    UPDATE public.app_trial_status
       SET status = 'expired', updated_at = now()
     WHERE status = 'active'
       AND expires_at IS NOT NULL
       AND expires_at < now()
    RETURNING organization_id, app_id
  ),
  audited AS (
    INSERT INTO public.commercial_audit_logs (org_id, event_type, app_id, payload)
    SELECT organization_id, 'trial_expired', app_id, jsonb_build_object('source','disable_expired_app_trials')
      FROM newly_expired
    RETURNING 1
  )
  SELECT count(*)::int INTO v_expired FROM newly_expired;

  -- 2) For orgs whose expired trial is NOT covered by plan or override,
  --    flip the install row to read-only-ish state.
  WITH expired_trials AS (
    SELECT t.organization_id, t.app_id
      FROM public.app_trial_status t
     WHERE t.status = 'expired'
       AND t.expires_at IS NOT NULL
       AND t.expires_at < now()
  ),
  no_other_entitlement AS (
    SELECT et.organization_id, et.app_id
      FROM expired_trials et
      JOIN public.organizations o ON o.id = et.organization_id
     WHERE NOT EXISTS (
        SELECT 1 FROM public.plan_app_access paa
         WHERE paa.plan_id = o.subscription_plan_id
           AND paa.app_id  = et.app_id
           AND paa.is_enabled = true
     )
       AND NOT EXISTS (
        SELECT 1 FROM public.org_entitlement_overrides oe
         WHERE oe.organization_id = et.organization_id
           AND oe.override_type   = 'app'
           AND oe.key             = et.app_id
           AND oe.is_active       = true
           AND (oe.expires_at IS NULL OR oe.expires_at > now())
     )
  ),
  disabled AS (
    UPDATE public.organization_installed_apps oia
       SET lifecycle_state = 'trial_expired'::app_lifecycle_state,
           is_active       = false,
           updated_at      = now()
      FROM no_other_entitlement noe
     WHERE oia.organization_id = noe.organization_id
       AND oia.app_id          = noe.app_id
       AND oia.is_active       = true
    RETURNING oia.organization_id, oia.app_id
  ),
  audited2 AS (
    INSERT INTO public.commercial_audit_logs (org_id, event_type, app_id, payload)
    SELECT organization_id, 'app_disabled_post_trial', app_id, jsonb_build_object('reason','no_plan_or_override')
      FROM disabled
    RETURNING 1
  )
  SELECT count(*)::int INTO v_disabled FROM disabled;

  RETURN QUERY SELECT v_expired, v_disabled;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. B2 fix — convert_app_trials_on_plan_change
--    Use the real column plan_app_access.plan_id.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.convert_app_trials_on_plan_change(p_org_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _converted integer := 0;
BEGIN
  WITH org_plan AS (
    SELECT id AS organization_id, subscription_plan_id
      FROM public.organizations
     WHERE (p_org_id IS NULL OR id = p_org_id)
       AND subscription_plan_id IS NOT NULL
  ),
  candidates AS (
    SELECT ats.id, ats.organization_id, ats.app_id
      FROM public.app_trial_status ats
      JOIN org_plan op ON op.organization_id = ats.organization_id
      JOIN public.plan_app_access paa
        ON paa.plan_id = op.subscription_plan_id
       AND paa.app_id  = ats.app_id
       AND paa.is_enabled = true
     WHERE ats.status = 'active'
  ),
  upd AS (
    UPDATE public.app_trial_status t
       SET status       = 'converted',
           converted_at = COALESCE(t.converted_at, now()),
           updated_at   = now()
      FROM candidates c
     WHERE t.id = c.id
    RETURNING c.organization_id, c.app_id
  ),
  sync_install AS (
    UPDATE public.organization_installed_apps oia
       SET lifecycle_state = 'active'::app_lifecycle_state,
           is_active       = true,
           updated_at      = now()
      FROM upd
     WHERE oia.organization_id = upd.organization_id
       AND oia.app_id          = upd.app_id
    RETURNING 1
  ),
  audited AS (
    INSERT INTO public.commercial_audit_logs (org_id, event_type, app_id, payload)
    SELECT organization_id, 'trial_converted', app_id,
           jsonb_build_object('reason','plan_includes_app')
      FROM upd
    RETURNING 1
  )
  SELECT count(*) INTO _converted FROM upd;

  RETURN _converted;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. B3 fix — keep organization_installed_apps.lifecycle_state in sync
-- -----------------------------------------------------------------------------

-- 5a. Update install_app: stamp lifecycle_state at insert time based on
--     whether entitlement comes from plan/override (active) or trial (trial).
CREATE OR REPLACE FUNCTION public.install_app(p_org_id uuid, p_app_id text)
RETURNS organization_installed_apps
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result public.organization_installed_apps;
  v_use_per_user boolean := false;
  v_max_apps int;
  v_current_count int;
  v_plan_name text;
  v_already_installed boolean;
  v_business_count int;
  v_dep RECORD;
  v_plan_id uuid;
  v_in_plan boolean;
  v_overridden boolean;
  v_on_trial boolean;
  v_state public.app_lifecycle_state;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = auth.uid()
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
        p_app_id USING ERRCODE = 'P0001', HINT = 'no_business';
    END IF;
  END IF;

  SELECT (setting_value::boolean) INTO v_use_per_user
    FROM public.platform_settings
   WHERE setting_key = 'use_per_user_billing'
   LIMIT 1;
  v_use_per_user := COALESCE(v_use_per_user, false);

  SELECT EXISTS (
    SELECT 1 FROM public.organization_installed_apps
     WHERE organization_id = p_org_id AND app_id = p_app_id AND is_active = true
  ) INTO v_already_installed;

  IF v_use_per_user AND NOT v_already_installed AND p_app_id <> 'platform' THEN
    SELECT psp.max_installed_apps, psp.name INTO v_max_apps, v_plan_name
      FROM public.organizations o
      JOIN public.platform_subscription_plans psp ON psp.id = o.subscription_plan_id
     WHERE o.id = p_org_id;
    IF v_max_apps IS NOT NULL THEN
      SELECT COUNT(*) INTO v_current_count
        FROM public.organization_installed_apps
       WHERE organization_id = p_org_id AND is_active = true AND app_id <> 'platform';
      IF v_current_count >= v_max_apps THEN
        RAISE EXCEPTION 'SETUP_REQUIRED: Your % plan includes % app(s). Upgrade to install more.',
          COALESCE(v_plan_name, 'current'), v_max_apps USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  -- Auto-install transitive dependencies (Odoo `depends:` semantics)
  FOR v_dep IN
    WITH RECURSIVE deps AS (
      SELECT depends_on_app_id AS app_id, 1 AS depth
        FROM public.app_dependencies
       WHERE app_id = p_app_id
      UNION
      SELECT ad.depends_on_app_id, d.depth + 1
        FROM public.app_dependencies ad
        JOIN deps d ON d.app_id = ad.app_id
       WHERE d.depth < 6
    )
    SELECT DISTINCT app_id FROM deps ORDER BY app_id
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.organization_installed_apps
       WHERE organization_id = p_org_id AND app_id = v_dep.app_id AND is_active = true
    ) THEN
      PERFORM public.assert_entitlement(p_org_id, v_dep.app_id);

      -- Resolve dep state at install time
      SELECT subscription_plan_id INTO v_plan_id FROM public.organizations WHERE id = p_org_id;
      SELECT EXISTS (SELECT 1 FROM public.plan_app_access
                      WHERE plan_id = v_plan_id AND app_id = v_dep.app_id AND is_enabled = true)
        INTO v_in_plan;
      SELECT EXISTS (SELECT 1 FROM public.org_entitlement_overrides
                      WHERE organization_id = p_org_id AND override_type = 'app' AND key = v_dep.app_id
                        AND is_active = true AND (expires_at IS NULL OR expires_at > now()))
        INTO v_overridden;
      SELECT EXISTS (SELECT 1 FROM public.app_trial_status
                      WHERE organization_id = p_org_id AND app_id = v_dep.app_id
                        AND status = 'active' AND expires_at > now())
        INTO v_on_trial;
      v_state := CASE WHEN v_in_plan OR v_overridden THEN 'active'
                      WHEN v_on_trial THEN 'trial'
                      ELSE 'active' END::public.app_lifecycle_state;

      INSERT INTO public.organization_installed_apps
        (organization_id, app_id, installed_by, is_active, lifecycle_state)
      VALUES (p_org_id, v_dep.app_id, auth.uid(), true, v_state)
      ON CONFLICT (organization_id, app_id) DO UPDATE
        SET is_active = true,
            lifecycle_state = v_state,
            updated_at = now();

      PERFORM public.seed_app_data(p_org_id, v_dep.app_id);
      PERFORM public.log_commercial_event(p_org_id, 'app_installed', v_dep.app_id, v_plan_id,
                jsonb_build_object('source','dependency_of','requested_app',p_app_id,'state',v_state::text));
    END IF;
  END LOOP;

  -- Install the requested app
  PERFORM public.assert_entitlement(p_org_id, p_app_id);

  SELECT subscription_plan_id INTO v_plan_id FROM public.organizations WHERE id = p_org_id;
  SELECT EXISTS (SELECT 1 FROM public.plan_app_access
                  WHERE plan_id = v_plan_id AND app_id = p_app_id AND is_enabled = true)
    INTO v_in_plan;
  SELECT EXISTS (SELECT 1 FROM public.org_entitlement_overrides
                  WHERE organization_id = p_org_id AND override_type = 'app' AND key = p_app_id
                    AND is_active = true AND (expires_at IS NULL OR expires_at > now()))
    INTO v_overridden;
  SELECT EXISTS (SELECT 1 FROM public.app_trial_status
                  WHERE organization_id = p_org_id AND app_id = p_app_id
                    AND status = 'active' AND expires_at > now())
    INTO v_on_trial;
  v_state := CASE WHEN v_in_plan OR v_overridden THEN 'active'
                  WHEN v_on_trial THEN 'trial'
                  ELSE 'active' END::public.app_lifecycle_state;

  INSERT INTO public.organization_installed_apps
    (organization_id, app_id, installed_by, is_active, lifecycle_state)
  VALUES (p_org_id, p_app_id, auth.uid(), true, v_state)
  ON CONFLICT (organization_id, app_id) DO UPDATE
    SET is_active = true,
        lifecycle_state = v_state,
        updated_at = now()
  RETURNING * INTO v_result;

  PERFORM public.seed_app_data(p_org_id, p_app_id);
  PERFORM public.log_commercial_event(p_org_id, 'app_installed', p_app_id, v_plan_id,
            jsonb_build_object('state', v_state::text, 'in_plan', v_in_plan,
                               'overridden', v_overridden, 'on_trial', v_on_trial));
  RETURN v_result;
END;
$$;

-- 5b. Trigger: when app_trial_status flips, sync the install row's lifecycle_state.
CREATE OR REPLACE FUNCTION public.sync_install_lifecycle_on_trial_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'active' THEN
    UPDATE public.organization_installed_apps
       SET lifecycle_state = 'trial'::public.app_lifecycle_state,
           is_active = true,
           updated_at = now()
     WHERE organization_id = NEW.organization_id AND app_id = NEW.app_id;
  ELSIF NEW.status = 'converted' THEN
    UPDATE public.organization_installed_apps
       SET lifecycle_state = 'active'::public.app_lifecycle_state,
           is_active = true,
           updated_at = now()
     WHERE organization_id = NEW.organization_id AND app_id = NEW.app_id;
  ELSIF NEW.status IN ('expired','cancelled') THEN
    -- Only flip to trial_expired if no plan/override entitlement remains.
    UPDATE public.organization_installed_apps oia
       SET lifecycle_state = 'trial_expired'::public.app_lifecycle_state,
           updated_at = now()
      FROM public.organizations o
     WHERE oia.organization_id = NEW.organization_id
       AND oia.app_id          = NEW.app_id
       AND o.id                = NEW.organization_id
       AND NOT EXISTS (
         SELECT 1 FROM public.plan_app_access paa
          WHERE paa.plan_id = o.subscription_plan_id
            AND paa.app_id  = NEW.app_id
            AND paa.is_enabled = true
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.org_entitlement_overrides oe
          WHERE oe.organization_id = NEW.organization_id
            AND oe.override_type   = 'app'
            AND oe.key             = NEW.app_id
            AND oe.is_active       = true
            AND (oe.expires_at IS NULL OR oe.expires_at > now())
       );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_install_lifecycle ON public.app_trial_status;
CREATE TRIGGER trg_sync_install_lifecycle
AFTER INSERT OR UPDATE OF status ON public.app_trial_status
FOR EACH ROW EXECUTE FUNCTION public.sync_install_lifecycle_on_trial_change();

-- 5c. Backfill: ensure existing rows have a coherent lifecycle_state.
-- All current rows are 'active' (verified). Promote trial-installed rows
-- to 'trial' where an active trial exists.
UPDATE public.organization_installed_apps oia
   SET lifecycle_state = 'trial'::public.app_lifecycle_state
  FROM public.app_trial_status ats
 WHERE oia.organization_id = ats.organization_id
   AND oia.app_id          = ats.app_id
   AND ats.status          = 'active'
   AND ats.expires_at      > now()
   AND oia.lifecycle_state = 'active'::public.app_lifecycle_state;

-- -----------------------------------------------------------------------------
-- 6. start_app_trial — also write audit row (additive)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_app_trial(p_org_id uuid, p_app_id text, p_days integer DEFAULT 14)
RETURNS app_trial_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.app_trial_status;
  v_existing public.app_trial_status;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = auth.uid() AND organization_id = p_org_id
       AND role IN ('owner','admin') AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  IF p_days <= 0 OR p_days > 90 THEN
    RAISE EXCEPTION 'Invalid trial length (1-90 days)';
  END IF;

  SELECT * INTO v_existing FROM public.app_trial_status
   WHERE organization_id = p_org_id AND app_id = p_app_id;

  IF v_existing.id IS NOT NULL AND v_existing.status = 'converted' THEN
    RAISE EXCEPTION 'TRIAL_ALREADY_USED: % was already trialled and converted.', p_app_id
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.app_trial_status (organization_id, app_id, status, started_at, expires_at)
  VALUES (p_org_id, p_app_id, 'active', now(), now() + (p_days || ' days')::interval)
  ON CONFLICT (organization_id, app_id) DO UPDATE
    SET status = 'active',
        started_at = now(),
        expires_at = now() + (p_days || ' days')::interval,
        updated_at = now()
  RETURNING * INTO v_row;

  PERFORM public.log_commercial_event(p_org_id, 'trial_started', p_app_id, NULL,
            jsonb_build_object('days', p_days, 'expires_at', v_row.expires_at));
  RETURN v_row;
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. uninstall_app — write audit row (preserve existing logic; thin wrapper-style).
--    We re-define to add audit; keep dependency-block behavior via existing
--    block_app_uninstall_if_dependents_active trigger.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.uninstall_app(p_org_id uuid, p_app_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = auth.uid()
       AND organization_id = p_org_id
       AND role IN ('owner','admin')
       AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  UPDATE public.organization_installed_apps
     SET is_active = false,
         lifecycle_state = 'uninstalled_readonly'::public.app_lifecycle_state,
         updated_at = now()
   WHERE organization_id = p_org_id
     AND app_id = p_app_id;

  PERFORM public.log_commercial_event(p_org_id, 'app_uninstalled', p_app_id, NULL, '{}'::jsonb);
  RETURN true;
END;
$$;

-- -----------------------------------------------------------------------------
-- 8. compute_org_billing — additive: include billing_warnings for misconfigured
--    add-ons (installed but no pricing rule, or zero price).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_org_billing(p_org_id uuid, p_billing_cycle text DEFAULT 'monthly')
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan RECORD;
  v_currency text;
  v_plan_price numeric := 0;
  v_user_count int := 0;
  v_addons jsonb := '[]'::jsonb;
  v_addons_total numeric := 0;
  v_total numeric := 0;
  v_cycle text := lower(coalesce(p_billing_cycle, 'monthly'));
  v_warnings jsonb := '[]'::jsonb;
BEGIN
  IF p_org_id IS NULL THEN
    RETURN jsonb_build_object('error','org_id_required');
  END IF;
  IF v_cycle NOT IN ('monthly','yearly') THEN v_cycle := 'monthly'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = auth.uid() AND organization_id = p_org_id AND is_active = true
  ) AND NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = auth.uid() AND role = 'super_admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Unauthorized: caller is not a member of organization %', p_org_id
      USING ERRCODE = '42501';
  END IF;

  SELECT psp.id, psp.name, psp.price_monthly, psp.price_yearly,
         psp.price_per_user_monthly, psp.price_per_user_yearly,
         coalesce(psp.currency, psp.base_currency, 'USD') AS currency
    INTO v_plan
    FROM public.organizations o
    LEFT JOIN public.platform_subscription_plans psp ON psp.id = o.subscription_plan_id
   WHERE o.id = p_org_id;

  IF v_plan.id IS NULL THEN
    v_currency := 'USD';
  ELSE
    v_currency := v_plan.currency;
    v_plan_price := CASE WHEN v_cycle = 'yearly' THEN coalesce(v_plan.price_yearly, 0)
                         ELSE coalesce(v_plan.price_monthly, 0) END;
    IF (v_cycle = 'monthly' AND coalesce(v_plan.price_per_user_monthly, 0) > 0)
       OR (v_cycle = 'yearly' AND coalesce(v_plan.price_per_user_yearly, 0) > 0) THEN
      SELECT COUNT(DISTINCT user_id) INTO v_user_count
        FROM public.user_roles
       WHERE organization_id = p_org_id AND is_active = true;
      v_plan_price := v_plan_price + (v_user_count * CASE WHEN v_cycle = 'yearly'
                                                          THEN coalesce(v_plan.price_per_user_yearly, 0)
                                                          ELSE coalesce(v_plan.price_per_user_monthly, 0) END);
    END IF;
  END IF;

  WITH installed AS (
    SELECT oia.app_id FROM public.organization_installed_apps oia
     WHERE oia.organization_id = p_org_id AND coalesce(oia.is_active, true) = true
  ),
  in_plan AS (
    SELECT app_id FROM public.plan_app_access WHERE plan_id = v_plan.id AND is_enabled = true
  ),
  on_trial AS (
    SELECT app_id FROM public.app_trial_status
     WHERE organization_id = p_org_id AND status = 'active' AND expires_at > now()
  ),
  billable AS (
    SELECT i.app_id FROM installed i
     WHERE NOT EXISTS (SELECT 1 FROM in_plan p WHERE p.app_id = i.app_id)
       AND NOT EXISTS (SELECT 1 FROM on_trial t WHERE t.app_id = i.app_id)
  ),
  priced AS (
    SELECT b.app_id,
           apr.monthly_price, apr.yearly_price, apr.is_per_user, apr.is_active AS rule_active,
           coalesce(
             CASE WHEN v_cycle = 'yearly' THEN apr.yearly_price ELSE apr.monthly_price END
             * CASE WHEN coalesce(apr.is_per_user, false)
                    THEN GREATEST(1, (SELECT COUNT(DISTINCT user_id)::int
                                        FROM public.user_roles
                                       WHERE organization_id = p_org_id AND is_active = true))
                    ELSE 1 END,
             0) AS line_total
      FROM billable b
      LEFT JOIN public.app_pricing_rules apr
        ON apr.app_id = b.app_id AND coalesce(apr.is_active, true) = true
  )
  SELECT
    coalesce(jsonb_agg(jsonb_build_object(
      'app_id', app_id,
      'monthly_price', coalesce(monthly_price, 0),
      'yearly_price',  coalesce(yearly_price, 0),
      'is_per_user',   coalesce(is_per_user, false),
      'line_total',    line_total
    ) ORDER BY app_id), '[]'::jsonb),
    coalesce(SUM(line_total), 0),
    coalesce(jsonb_agg(
      jsonb_build_object('app_id', app_id, 'kind', 'addon_without_price')
      ORDER BY app_id
    ) FILTER (WHERE monthly_price IS NULL AND yearly_price IS NULL), '[]'::jsonb)
    ||
    coalesce(jsonb_agg(
      jsonb_build_object('app_id', app_id, 'kind', 'addon_with_zero_price')
      ORDER BY app_id
    ) FILTER (WHERE coalesce(monthly_price,0) = 0 AND coalesce(yearly_price,0) = 0
              AND (monthly_price IS NOT NULL OR yearly_price IS NOT NULL)), '[]'::jsonb)
    INTO v_addons, v_addons_total, v_warnings
    FROM priced;

  v_total := v_plan_price + v_addons_total;

  RETURN jsonb_build_object(
    'org_id',           p_org_id,
    'plan_id',          v_plan.id,
    'plan_name',        v_plan.name,
    'billing_cycle',    v_cycle,
    'currency',         v_currency,
    'user_count',       v_user_count,
    'plan_price',       v_plan_price,
    'addons',           v_addons,
    'addons_total',     v_addons_total,
    'total',            v_total,
    'billing_warnings', v_warnings,
    'computed_at',      now()
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 9. Grants
-- -----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.disable_expired_app_trials() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.convert_app_trials_on_plan_change(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.uninstall_app(uuid, text) TO authenticated, service_role;

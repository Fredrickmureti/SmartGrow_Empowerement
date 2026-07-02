-- =====================================================================
-- Phase A — Stop the bleed
-- 1) Harden usage-counter triggers so org-deletion (and any reset) never
--    hits org_usage_counters_organization_id_fkey.
-- 2) Fix get_user_session_data so it stops referencing the dropped
--    organizations.logo_url column. Pull the per-org logo from the oldest
--    active business (matches the deprecation note left in 20260426234021).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1a) refresh_user_counter — fires on user_roles INSERT/DELETE.
--     During platform_delete_organization the organization row is gone
--     before the cascaded user_roles deletes finish, so the upsert into
--     org_usage_counters violated the FK. Bypass when the reset GUC is
--     set and defensively skip when the org row no longer exists.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_user_counter()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org_id uuid;
  _count integer;
  _reset_org text;
BEGIN
  _org_id := COALESCE(NEW.organization_id, OLD.organization_id);

  IF _org_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Bypass during reset_organization_data / platform_delete_organization.
  _reset_org := current_setting('app.reset_in_progress', true);
  IF _reset_org IS NOT NULL AND _reset_org = _org_id::text THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Defensive: if the org no longer exists, never attempt the FK-bound upsert.
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = _org_id) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT COUNT(DISTINCT user_id) INTO _count
  FROM public.user_roles
  WHERE organization_id = _org_id;

  INSERT INTO public.org_usage_counters (organization_id, metric_key, current_value, period_start, period_end)
  VALUES (
    _org_id,
    'users_count',
    _count,
    date_trunc('month', now()),
    date_trunc('month', now()) + interval '1 month' - interval '1 second'
  )
  ON CONFLICT (organization_id, metric_key, period_start)
  DO UPDATE SET current_value = _count;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- ---------------------------------------------------------------------
-- 1b) increment_invoice_counter — same hardening for symmetry. Even
--     though INSERT-only triggers don't fire during cascaded deletes,
--     reset_module__sales may insert audit rows or future code may add
--     new INSERT paths. Make the trigger universally safe.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.increment_invoice_counter()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _reset_org text;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RETURN NEW;
  END IF;

  _reset_org := current_setting('app.reset_in_progress', true);
  IF _reset_org IS NOT NULL AND _reset_org = NEW.organization_id::text THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = NEW.organization_id) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.org_usage_counters (organization_id, metric_key, current_value, period_start, period_end)
  VALUES (
    NEW.organization_id,
    'invoices_count',
    1,
    date_trunc('month', now()),
    date_trunc('month', now()) + interval '1 month' - interval '1 second'
  )
  ON CONFLICT (organization_id, metric_key, period_start)
  DO UPDATE SET current_value = public.org_usage_counters.current_value + 1;

  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------
-- 1c) increment_pos_counter — same hardening.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.increment_pos_counter()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _reset_org text;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RETURN NEW;
  END IF;

  _reset_org := current_setting('app.reset_in_progress', true);
  IF _reset_org IS NOT NULL AND _reset_org = NEW.organization_id::text THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = NEW.organization_id) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.org_usage_counters (organization_id, metric_key, current_value, period_start, period_end)
  VALUES (
    NEW.organization_id,
    'pos_transactions_count',
    1,
    date_trunc('month', now()),
    date_trunc('month', now()) + interval '1 month' - interval '1 second'
  )
  ON CONFLICT (organization_id, metric_key, period_start)
  DO UPDATE SET current_value = public.org_usage_counters.current_value + 1;

  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------
-- 2) get_user_session_data — stop referencing organizations.logo_url
--    (column was dropped). Resolve per-org logo from the oldest active
--    business in that org (Odoo res.company-style: company-level branding,
--    not org-level). Returned shape unchanged so the frontend keeps
--    working without code changes.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_user_session_data(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  result jsonb;
  org_array jsonb := '[]'::jsonb;
  org_row record;
  plan_data jsonb;
  apps jsonb;
  features jsonb;
  overrides jsonb;
  user_count int;
  storage_used numeric;
  org_entry jsonb;
  is_admin boolean;
  role_row record;
  group_rules jsonb;
  v_logo_url text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.platform_admins WHERE user_id = p_user_id AND is_active = true
  ) INTO is_admin;

  FOR org_row IN
    SELECT
      o.id, o.name, o.slug,
      o.subscription_plan_id, o.subscription_status,
      o.subscription_started_at, o.subscription_ends_at,
      o.trial_ends_at, o.is_suspended, o.suspended_at, o.suspended_reason
    FROM public.organizations o
    JOIN public.user_roles ur ON ur.organization_id = o.id
    WHERE ur.user_id = p_user_id AND ur.is_active = true
    ORDER BY o.created_at ASC
  LOOP
    -- Resolve org-level logo from the primary (oldest active) business.
    SELECT b.logo_url
      INTO v_logo_url
    FROM public.businesses b
    WHERE b.organization_id = org_row.id
      AND b.is_active = true
      AND b.logo_url IS NOT NULL
    ORDER BY b.created_at ASC
    LIMIT 1;

    SELECT ur.id AS role_id, ur.role, COALESCE(ur.user_type, 'internal') AS user_type
    INTO role_row
    FROM public.user_roles ur
    WHERE ur.user_id = p_user_id AND ur.organization_id = org_row.id AND ur.is_active = true
    LIMIT 1;

    SELECT jsonb_build_object(
      'id', p.id, 'name', p.name, 'description', p.description,
      'price_monthly', p.price_monthly, 'price_yearly', p.price_yearly,
      'features', COALESCE(p.features, '[]'::jsonb),
      'max_users', p.max_users, 'max_invoices_per_month', p.max_invoices_per_month,
      'max_organizations', COALESCE(p.max_organizations, 1),
      'grace_period_days', p.grace_period_days, 'max_storage_mb', p.max_storage_mb
    ) INTO plan_data
    FROM public.platform_subscription_plans p
    WHERE p.id = org_row.subscription_plan_id;

    SELECT COALESCE(jsonb_agg(app_id), '[]'::jsonb) INTO apps
    FROM public.plan_app_access
    WHERE plan_id = org_row.subscription_plan_id AND is_enabled = true;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('key', feature_key, 'value', limit_value)), '[]'::jsonb)
    INTO features
    FROM public.plan_feature_access
    WHERE plan_id = org_row.subscription_plan_id AND is_enabled = true;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'type', override_type, 'key', key, 'value', override_value, 'expires_at', expires_at
    )), '[]'::jsonb) INTO overrides
    FROM public.org_entitlement_overrides
    WHERE organization_id = org_row.id AND is_active = true
      AND (expires_at IS NULL OR expires_at > now());

    SELECT COUNT(DISTINCT user_id) INTO user_count
    FROM public.user_roles WHERE organization_id = org_row.id AND is_active = true;

    BEGIN
      SELECT COALESCE(public.get_org_storage_usage_mb(org_row.id), 0) INTO storage_used;
    EXCEPTION WHEN OTHERS THEN
      storage_used := 0;
    END;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'module', pgr.module, 'can_read', pgr.can_read, 'can_create', pgr.can_create,
      'can_write', pgr.can_write, 'can_delete', pgr.can_delete
    )), '[]'::jsonb) INTO group_rules
    FROM public.member_permission_groups mpg
    JOIN public.permission_group_rules pgr ON pgr.permission_group_id = mpg.permission_group_id
    WHERE mpg.user_id = p_user_id AND mpg.organization_id = org_row.id;

    org_entry := jsonb_build_object(
      'id', org_row.id, 'name', org_row.name, 'slug', org_row.slug,
      'logo_url', v_logo_url,
      'subscription_plan_id', org_row.subscription_plan_id,
      'subscription_status', org_row.subscription_status,
      'subscription_started_at', org_row.subscription_started_at,
      'subscription_ends_at', org_row.subscription_ends_at,
      'trial_ends_at', org_row.trial_ends_at,
      'is_suspended', org_row.is_suspended,
      'suspended_at', org_row.suspended_at,
      'suspended_reason', org_row.suspended_reason,
      'role', COALESCE(role_row.role::text, 'staff'),
      'role_id', role_row.role_id,
      'user_type', role_row.user_type,
      'plan', plan_data,
      'app_entitlements', apps,
      'entitled_features', features,
      'overrides', overrides,
      'usage_counters', jsonb_build_object(
        'users_count', user_count,
        'storage_used_mb', storage_used
      ),
      'permission_group_rules', group_rules
    );

    org_array := org_array || jsonb_build_array(org_entry);
  END LOOP;

  result := jsonb_build_object(
    'user_id', p_user_id,
    'is_platform_admin', is_admin,
    'organizations', org_array,
    'fetched_at', now()
  );
  RETURN result;
END
$function$;
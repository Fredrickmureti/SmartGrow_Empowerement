
-- ============================================================================
-- Phase 8 Steps 7, 8, 9 — final consolidation
-- ============================================================================

-- ── Step 7 (server-side): re-source org identity from primary business ─────
-- Patch get_user_session_data so currentOrg.{logo_url,address,...} are taken
-- from businesses. This back-fills every frontend reader (32+ files) without
-- touching them. Keeps the legacy column names so SessionOrganization type
-- and all consumers stay binary-compatible.
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
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM platform_admins WHERE user_id = p_user_id AND is_active = true
  ) INTO is_admin;

  FOR org_row IN
    SELECT
      o.id, o.name, o.slug,
      -- identity now sourced from primary business (Odoo model)
      COALESCE(b.logo_url,    o.logo_url)    AS logo_url,
      COALESCE(b.base_currency, 'USD')       AS base_currency,
      COALESCE(b.email,       o.email)       AS email,
      COALESCE(b.phone,       o.phone)       AS phone,
      COALESCE(b.address,     o.address)     AS address,
      COALESCE(b.city,        o.city)        AS city,
      COALESCE(b.state,       o.state)       AS state,
      COALESCE(b.postal_code, o.postal_code) AS postal_code,
      COALESCE(b.country,     o.country)     AS country,
      o.subscription_plan_id, o.subscription_status,
      o.subscription_started_at, o.subscription_ends_at,
      o.trial_ends_at, o.is_suspended, o.suspended_at, o.suspended_reason
    FROM organizations o
    JOIN user_roles ur ON ur.organization_id = o.id
    LEFT JOIN LATERAL (
      SELECT bb.*
      FROM businesses bb
      WHERE bb.organization_id = o.id AND bb.is_active = true
      ORDER BY bb.created_at ASC
      LIMIT 1
    ) b ON true
    WHERE ur.user_id = p_user_id AND ur.is_active = true
    ORDER BY o.created_at ASC
  LOOP
    SELECT ur.id AS role_id, ur.role, COALESCE(ur.user_type, 'internal') AS user_type
    INTO role_row
    FROM user_roles ur
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
    FROM platform_subscription_plans p
    WHERE p.id = org_row.subscription_plan_id;

    SELECT COALESCE(jsonb_agg(app_id), '[]'::jsonb) INTO apps
    FROM plan_app_access
    WHERE plan_id = org_row.subscription_plan_id AND is_enabled = true;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('key', feature_key, 'value', limit_value)), '[]'::jsonb)
    INTO features
    FROM plan_feature_access
    WHERE plan_id = org_row.subscription_plan_id AND is_enabled = true;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'type', override_type, 'key', key, 'value', override_value, 'expires_at', expires_at
    )), '[]'::jsonb) INTO overrides
    FROM org_entitlement_overrides
    WHERE organization_id = org_row.id AND is_active = true
      AND (expires_at IS NULL OR expires_at > now());

    SELECT COUNT(DISTINCT user_id) INTO user_count
    FROM user_roles WHERE organization_id = org_row.id AND is_active = true;

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
      'logo_url', org_row.logo_url, 'base_currency', org_row.base_currency,
      'email', org_row.email, 'phone', org_row.phone,
      'address', org_row.address, 'city', org_row.city, 'state', org_row.state,
      'postal_code', org_row.postal_code, 'country', org_row.country,
      'subscription_plan_id', org_row.subscription_plan_id,
      'subscription_status', org_row.subscription_status,
      'subscription_started_at', org_row.subscription_started_at,
      'subscription_ends_at', org_row.subscription_ends_at,
      'trial_ends_at', org_row.trial_ends_at,
      'is_suspended', org_row.is_suspended,
      'suspended_at', org_row.suspended_at,
      'suspended_reason', org_row.suspended_reason,
      'role', COALESCE(role_row.role, 'internal'),
      'role_id', role_row.role_id,
      'user_type', COALESCE(role_row.user_type, 'internal'),
      'plan', plan_data,
      'app_entitlements', apps,
      'entitlements', features,
      'feature_limits', '{}'::jsonb,
      'limit_overrides', overrides,
      'usage_counters', jsonb_build_object(
        'users_count', user_count,
        'invoices_this_month', 0,
        'businesses_count', (SELECT COUNT(*) FROM businesses WHERE organization_id = org_row.id AND is_active = true),
        'storage_used_mb', storage_used
      ),
      'permission_group_rules', group_rules,
      'computed_status', jsonb_build_object(
        'is_active', NOT COALESCE(org_row.is_suspended, false)
                     AND (org_row.subscription_status IN ('active','trial')
                          OR org_row.subscription_status IS NULL),
        'is_suspended', COALESCE(org_row.is_suspended, false),
        'is_trialing', org_row.subscription_status = 'trial',
        'is_expired',
          (org_row.subscription_status = 'trial'
            AND org_row.trial_ends_at IS NOT NULL
            AND org_row.trial_ends_at < now())
          OR
          (org_row.subscription_ends_at IS NOT NULL
            AND org_row.subscription_ends_at < now()),
        'days_remaining',
          CASE
            WHEN org_row.subscription_status = 'trial' AND org_row.trial_ends_at IS NOT NULL
              THEN GREATEST(0, EXTRACT(DAY FROM (org_row.trial_ends_at - now()))::int)
            WHEN org_row.subscription_ends_at IS NOT NULL
              THEN GREATEST(0, EXTRACT(DAY FROM (org_row.subscription_ends_at - now()))::int)
            ELSE NULL
          END
      )
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
END;
$function$;

-- ── Step 8: extend create_organization_with_owner ──────────────────────────
CREATE OR REPLACE FUNCTION public.create_organization_with_owner(
  org_name text,
  org_slug text,
  org_country text DEFAULT NULL::text,
  org_currency text DEFAULT NULL::text,
  org_business_type text DEFAULT NULL::text,
  org_legal_name text DEFAULT NULL::text,
  org_is_multi_business boolean DEFAULT false
)
RETURNS organizations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  new_org public.organizations;
  default_plan_id UUID;
  trial_days INTEGER;
  new_business_id UUID;
  new_branch_id UUID;
  resolved_currency TEXT;
  resolved_country TEXT;
  resolved_legal_name TEXT;
BEGIN
  resolved_country    := COALESCE(NULLIF(org_country, ''), 'US');
  resolved_currency   := COALESCE(NULLIF(org_currency, ''), 'USD');
  resolved_legal_name := COALESCE(NULLIF(org_legal_name, ''), org_name);

  SELECT id, trial_period_days INTO default_plan_id, trial_days
  FROM public.platform_subscription_plans
  WHERE is_default = true AND is_active = true
  LIMIT 1;

  IF EXISTS (SELECT 1 FROM public.organizations WHERE slug = org_slug) THEN
    RAISE EXCEPTION 'Organization with this slug already exists';
  END IF;

  INSERT INTO public.organizations (
    name, slug, business_type,
    subscription_plan_id, subscription_status, trial_ends_at
  )
  VALUES (
    org_name, org_slug, NULLIF(org_business_type, ''),
    default_plan_id,
    CASE WHEN default_plan_id IS NOT NULL THEN 'trial' ELSE NULL END,
    CASE WHEN default_plan_id IS NOT NULL AND trial_days IS NOT NULL
         THEN NOW() + (trial_days || ' days')::INTERVAL
         ELSE NULL END
  )
  RETURNING * INTO new_org;

  INSERT INTO public.user_roles (organization_id, user_id, role, is_active)
  VALUES (new_org.id, auth.uid(), 'owner', true)
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  -- Single-business path: create exactly one default business now.
  -- Multi-business path: skip; the business-creation wizard will create them.
  IF NOT COALESCE(org_is_multi_business, false) THEN
    INSERT INTO public.businesses (
      organization_id, name, legal_name, country, base_currency, is_active
    )
    VALUES (
      new_org.id, org_name, resolved_legal_name, resolved_country, resolved_currency, true
    )
    RETURNING id INTO new_business_id;

    INSERT INTO public.branches (organization_id, business_id, name, is_headquarters, is_active)
    VALUES (new_org.id, new_business_id, 'Main Branch', true, true)
    RETURNING id INTO new_branch_id;

    INSERT INTO public.user_business_access (user_id, organization_id, business_id, is_primary, can_switch)
    VALUES (auth.uid(), new_org.id, new_business_id, true, true)
    ON CONFLICT (user_id, business_id) DO NOTHING;
  END IF;

  INSERT INTO public.subscription_usage (
    organization_id, period_start, period_end,
    invoices_count, users_count, pos_transactions_count, storage_used_mb, api_calls_count
  )
  VALUES (
    new_org.id,
    date_trunc('month', NOW())::date,
    (date_trunc('month', NOW()) + INTERVAL '1 month' - INTERVAL '1 day')::date,
    0, 1, 0, 0, 0
  );

  PERFORM public.seed_default_permission_groups(new_org.id);

  RETURN new_org;
END;
$function$;

-- ── Step 9: drop deprecated org identity columns ───────────────────────────
-- All readers now go through get_user_session_data (which sources from the
-- primary business) or directly through the businesses table. Org keeps
-- only tenant/billing/branding-for-account-switcher fields.
ALTER TABLE public.organizations
  DROP COLUMN IF EXISTS tax_id,
  DROP COLUMN IF EXISTS address,
  DROP COLUMN IF EXISTS city,
  DROP COLUMN IF EXISTS state,
  DROP COLUMN IF EXISTS country,
  DROP COLUMN IF EXISTS postal_code,
  DROP COLUMN IF EXISTS phone,
  DROP COLUMN IF EXISTS email,
  DROP COLUMN IF EXISTS website,
  DROP COLUMN IF EXISTS base_currency;

COMMENT ON TABLE public.organizations IS
  'Tenant/billing boundary. Identity (legal_name, tax_id, address, currency, logo, prefixes) lives in `businesses` (the legal/accounting entity). Org keeps only: name, slug, logo_url (account-switcher avatar only), subscription/billing fields, owner_user_id, fiscal_year_start, timezone, formatting defaults.';

COMMENT ON COLUMN public.organizations.logo_url IS
  'Tenant/account-switcher avatar only. Document branding MUST read businesses.logo_url.';

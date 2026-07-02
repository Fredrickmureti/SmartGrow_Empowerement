-- =====================================================================
-- Phase 1: Multi-Entity Architecture Cleanup (Odoo alignment)
-- =====================================================================

-- 1. BACKFILL: copy org-level identity values into the org's primary company
--    (no-op when there are no orgs/businesses, but safe for any future data).
DO $$
BEGIN
  UPDATE public.businesses b
     SET timezone           = COALESCE(b.timezone, o.timezone),
         fiscal_year_start  = COALESCE(b.fiscal_year_start, o.fiscal_year_start),
         default_tax_rate_id = COALESCE(b.default_tax_rate_id, o.default_tax_rate_id),
         default_payment_terms = COALESCE(b.default_payment_terms, o.default_payment_terms)
    FROM public.organizations o
   WHERE b.organization_id = o.id
     AND b.id = (
       SELECT id FROM public.businesses
        WHERE organization_id = o.id AND is_active = true
        ORDER BY created_at ASC LIMIT 1
     );
EXCEPTION WHEN undefined_column THEN
  -- Some columns may not exist on businesses; skip silently
  NULL;
END $$;

-- 2. DROP the old recovery functions (they silently re-created deleted companies
--    with US/USD defaults — anti-pattern that breaks user trust).
DROP FUNCTION IF EXISTS public.ensure_org_has_business(uuid);
DROP FUNCTION IF EXISTS public.ensure_org_has_business(uuid, text, text);
DROP FUNCTION IF EXISTS public.get_or_create_default_business_for_org(uuid);
DROP FUNCTION IF EXISTS public.get_or_create_default_business_for_org(uuid, text, text);

-- 3. DROP duplicate create_organization_with_owner overload (8-arg with org_company_name).
DROP FUNCTION IF EXISTS public.create_organization_with_owner(text, text, text, text, text, text, boolean, text);

-- 4. REPLACE create_organization_with_owner with a clean canonical version.
--    Always creates exactly 1 Company + 1 HQ Branch using the passed country/currency.
CREATE OR REPLACE FUNCTION public.create_organization_with_owner(
  org_name text,
  org_slug text,
  org_country text DEFAULT NULL,
  org_currency text DEFAULT NULL,
  org_business_type text DEFAULT NULL,
  org_legal_name text DEFAULT NULL,
  org_is_multi_business boolean DEFAULT false
)
RETURNS public.organizations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  new_org public.organizations;
  default_plan_id UUID;
  trial_days INTEGER;
  new_business_id UUID;
  resolved_currency TEXT;
  resolved_country TEXT;
  resolved_legal_name TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

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

  -- Workspace (tenant). Identity fields no longer stored here.
  INSERT INTO public.organizations (
    name, slug,
    subscription_plan_id, subscription_status, trial_ends_at,
    owner_user_id
  )
  VALUES (
    org_name, org_slug,
    default_plan_id,
    CASE WHEN default_plan_id IS NOT NULL THEN 'trial' ELSE NULL END,
    CASE WHEN default_plan_id IS NOT NULL AND trial_days IS NOT NULL
         THEN NOW() + (trial_days || ' days')::INTERVAL
         ELSE NULL END,
    auth.uid()
  )
  RETURNING * INTO new_org;

  INSERT INTO public.user_roles (organization_id, user_id, role, is_active)
  VALUES (new_org.id, auth.uid(), 'owner', true)
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  -- ALWAYS create exactly one Company + one HQ Branch (Odoo aligned).
  -- The "multi-business" toggle no longer skips this; users add more
  -- companies later via the in-app Company switcher.
  INSERT INTO public.businesses (
    organization_id, name, legal_name, country, base_currency,
    business_type, is_active
  )
  VALUES (
    new_org.id, org_name, resolved_legal_name,
    resolved_country, resolved_currency,
    NULLIF(org_business_type, ''), true
  )
  RETURNING id INTO new_business_id;

  INSERT INTO public.branches (
    organization_id, business_id, name, is_headquarters, is_active
  )
  VALUES (new_org.id, new_business_id, 'Main Branch', true, true);

  INSERT INTO public.user_business_access (
    user_id, organization_id, business_id, is_primary, can_switch
  )
  VALUES (auth.uid(), new_org.id, new_business_id, true, true)
  ON CONFLICT (user_id, business_id) DO NOTHING;

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

-- 5. Add provision_first_company — ONLY callable from onboarding by the owner
--    when the workspace has zero companies. No silent recreation.
CREATE OR REPLACE FUNCTION public.provision_first_company(
  _org_id uuid,
  _name text,
  _country text,
  _currency text,
  _business_type text DEFAULT NULL,
  _legal_name text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  caller_id UUID := auth.uid();
  is_owner BOOLEAN;
  existing_count INT;
  new_biz_id UUID;
BEGIN
  IF caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE organization_id = _org_id
       AND user_id = caller_id
       AND role IN ('owner','super_admin','admin')
       AND is_active = true
  ) INTO is_owner;

  IF NOT is_owner THEN
    RAISE EXCEPTION 'Only workspace owners can provision the first company';
  END IF;

  SELECT COUNT(*) INTO existing_count
    FROM public.businesses
   WHERE organization_id = _org_id AND is_active = true;

  IF existing_count > 0 THEN
    RAISE EXCEPTION 'This workspace already has at least one active company. Use the in-app "Add Company" action instead.';
  END IF;

  INSERT INTO public.businesses (
    organization_id, name, legal_name, country, base_currency,
    business_type, is_active
  )
  VALUES (
    _org_id, _name, COALESCE(_legal_name, _name),
    COALESCE(_country, 'US'), COALESCE(_currency, 'USD'),
    NULLIF(_business_type, ''), true
  )
  RETURNING id INTO new_biz_id;

  INSERT INTO public.branches (
    organization_id, business_id, name, is_headquarters, is_active
  )
  VALUES (_org_id, new_biz_id, 'Main Branch', true, true);

  INSERT INTO public.user_business_access (
    user_id, organization_id, business_id, is_primary, can_switch
  )
  SELECT ur.user_id, ur.organization_id, new_biz_id, true,
         (ur.role IN ('super_admin','owner','admin'))
    FROM public.user_roles ur
   WHERE ur.organization_id = _org_id AND ur.is_active = true
  ON CONFLICT (user_id, business_id) DO NOTHING;

  RETURN new_biz_id;
END;
$function$;

-- 6. Drop accounting-identity columns from organizations (now lives on businesses).
ALTER TABLE public.organizations DROP COLUMN IF EXISTS business_type;
ALTER TABLE public.organizations DROP COLUMN IF EXISTS industry;
ALTER TABLE public.organizations DROP COLUMN IF EXISTS timezone;
ALTER TABLE public.organizations DROP COLUMN IF EXISTS date_format;
ALTER TABLE public.organizations DROP COLUMN IF EXISTS fiscal_year_start;
ALTER TABLE public.organizations DROP COLUMN IF EXISTS default_tax_rate_id;
ALTER TABLE public.organizations DROP COLUMN IF EXISTS default_payment_terms;
ALTER TABLE public.organizations DROP COLUMN IF EXISTS email_display_name;
ALTER TABLE public.organizations DROP COLUMN IF EXISTS email_reply_to;
ALTER TABLE public.organizations DROP COLUMN IF EXISTS show_payment_methods_on_documents;
ALTER TABLE public.organizations DROP COLUMN IF EXISTS number_format;

-- 7. get_user_session_data: stop projecting org-level identity fields that no
--    longer exist on the table. All identity now flows from primary_business.
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
      COALESCE(b.logo_url, o.logo_url)       AS logo_url,
      COALESCE(b.base_currency, 'USD')       AS base_currency,
      b.email                                AS email,
      b.phone                                AS phone,
      b.address                              AS address,
      b.city                                 AS city,
      b.state                                AS state,
      b.postal_code                          AS postal_code,
      b.country                              AS country,
      b.id                                   AS primary_business_id,
      b.legal_name                           AS primary_business_legal_name,
      b.tax_id                               AS primary_business_tax_id,
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
      'logo_url', org_row.logo_url,
      'base_currency', org_row.base_currency,
      'country', org_row.country,
      'primary_business_id', org_row.primary_business_id,
      'primary_business', CASE WHEN org_row.primary_business_id IS NOT NULL THEN jsonb_build_object(
        'id', org_row.primary_business_id,
        'legal_name', org_row.primary_business_legal_name,
        'tax_id', org_row.primary_business_tax_id,
        'base_currency', org_row.base_currency,
        'country', org_row.country,
        'email', org_row.email,
        'phone', org_row.phone,
        'address', org_row.address,
        'city', org_row.city,
        'state', org_row.state,
        'postal_code', org_row.postal_code,
        'logo_url', org_row.logo_url
      ) ELSE NULL END,
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
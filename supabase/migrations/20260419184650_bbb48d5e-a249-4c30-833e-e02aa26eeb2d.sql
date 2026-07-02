
-- =====================================================================
-- Step 1.1 — Drop the legacy 5-arg overload of create_organization_with_owner
-- so PostgREST resolves to the 7-arg version that matches current schema.
-- =====================================================================
DROP FUNCTION IF EXISTS public.create_organization_with_owner(text, text, text, text, text);

-- =====================================================================
-- Step 1.2 — Rewrite get_or_create_default_business_for_org
-- Stop reading dropped columns org.country / org.base_currency.
-- If a primary business already exists in the org, reuse its currency/country.
-- Otherwise default to USD/US.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.get_or_create_default_business_for_org(_org_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  existing_biz_id UUID;
  new_biz_id UUID;
  org_name TEXT;
  caller_id UUID;
BEGIN
  SELECT id INTO existing_biz_id
  FROM businesses
  WHERE organization_id = _org_id AND is_active = true
  LIMIT 1;

  IF existing_biz_id IS NOT NULL THEN
    caller_id := auth.uid();
    IF caller_id IS NOT NULL THEN
      INSERT INTO user_business_access (user_id, organization_id, business_id, is_primary, can_switch)
      VALUES (caller_id, _org_id, existing_biz_id, true, true)
      ON CONFLICT (user_id, business_id) DO NOTHING;
    END IF;
    RETURN existing_biz_id;
  END IF;

  SELECT name INTO org_name FROM organizations WHERE id = _org_id;
  IF org_name IS NULL THEN
    RAISE EXCEPTION 'Organization not found';
  END IF;

  -- Identity now lives on businesses; default to safe values.
  INSERT INTO businesses (organization_id, name, country, is_active, base_currency)
  VALUES (_org_id, org_name, 'US', true, 'USD')
  RETURNING id INTO new_biz_id;

  -- Ensure default branch exists
  INSERT INTO branches (organization_id, business_id, name, is_headquarters, is_active)
  SELECT _org_id, new_biz_id, 'Main Branch', true, true
  WHERE NOT EXISTS (
    SELECT 1 FROM branches WHERE business_id = new_biz_id
  );

  -- Grant business access to all active org users
  INSERT INTO user_business_access (user_id, organization_id, business_id, is_primary, can_switch)
  SELECT ur.user_id, ur.organization_id, new_biz_id, true,
         (ur.role IN ('super_admin','owner','admin'))
  FROM user_roles ur
  WHERE ur.organization_id = _org_id AND ur.is_active = true
  ON CONFLICT (user_id, business_id) DO NOTHING;

  -- Backfill orphan products
  UPDATE products SET business_id = new_biz_id
  WHERE organization_id = _org_id AND business_id IS NULL;

  RETURN new_biz_id;
END;
$function$;

-- =====================================================================
-- Step 1.3 — Rewrite ensure_org_has_business
-- Replace hard-coded 'KES' with safe 'USD' default; stop assuming KES.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.ensure_org_has_business(_org_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  existing_business_id UUID;
  new_business_id UUID;
  org_name TEXT;
BEGIN
  SELECT id INTO existing_business_id
  FROM public.businesses
  WHERE organization_id = _org_id AND is_active = true
  LIMIT 1;

  IF existing_business_id IS NOT NULL THEN
    RETURN existing_business_id;
  END IF;

  SELECT name INTO org_name FROM public.organizations WHERE id = _org_id;

  INSERT INTO public.businesses (organization_id, name, country, is_active, base_currency)
  VALUES (_org_id, COALESCE(org_name, 'Default Business'), 'US', true, 'USD')
  RETURNING id INTO new_business_id;

  INSERT INTO public.branches (organization_id, business_id, name, is_headquarters, is_active)
  VALUES (_org_id, new_business_id, 'Main Branch', true, true);

  RETURN new_business_id;
END;
$function$;

-- =====================================================================
-- Step 1.4 — Fix get_user_session_data
-- The previous version selected o.email/o.phone/o.address/etc. which were
-- dropped from organizations. Source identity exclusively from the primary
-- business; only fall back to constants when no business exists.
-- Also expose primary_business_id for client-side use.
-- =====================================================================
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
      -- Identity sourced from primary business (Odoo model). org.logo_url
      -- still exists and is used for the tenant switcher avatar only.
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
      'logo_url', org_row.logo_url, 'base_currency', org_row.base_currency,
      'email', org_row.email, 'phone', org_row.phone,
      'address', org_row.address, 'city', org_row.city, 'state', org_row.state,
      'postal_code', org_row.postal_code, 'country', org_row.country,
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

-- =====================================================================
-- Step 4a — Currency immutability after first JE
-- Once a business has any journal entry, base_currency is locked.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.lock_business_currency_after_je()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.base_currency IS DISTINCT FROM OLD.base_currency THEN
    IF EXISTS (
      SELECT 1 FROM public.journal_entries
      WHERE business_id = NEW.id LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Cannot change base_currency for business % once journal entries exist (was %, attempted %)',
        NEW.id, OLD.base_currency, NEW.base_currency
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_business_currency_lock ON public.businesses;
CREATE TRIGGER trg_business_currency_lock
  BEFORE UPDATE OF base_currency ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.lock_business_currency_after_je();

-- =====================================================================
-- Step 4b — Branch / business org consistency
-- A branch's organization_id must match its business's organization_id.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.assert_branch_org_matches_business()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_biz_org uuid;
BEGIN
  IF NEW.business_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT organization_id INTO v_biz_org FROM public.businesses WHERE id = NEW.business_id;
  IF v_biz_org IS NULL THEN
    RAISE EXCEPTION 'Branch references non-existent business %', NEW.business_id
      USING ERRCODE = '23503';
  END IF;
  IF NEW.organization_id IS DISTINCT FROM v_biz_org THEN
    RAISE EXCEPTION 'Branch.organization_id (%) must equal business.organization_id (%) for business %',
      NEW.organization_id, v_biz_org, NEW.business_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_branch_org_consistency ON public.branches;
CREATE TRIGGER trg_branch_org_consistency
  BEFORE INSERT OR UPDATE ON public.branches
  FOR EACH ROW EXECUTE FUNCTION public.assert_branch_org_matches_business();

-- =====================================================================
-- Step 4c — JE business membership consistency (defense in depth)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.assert_je_business_belongs_to_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_biz_org uuid;
BEGIN
  IF NEW.business_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT organization_id INTO v_biz_org FROM public.businesses WHERE id = NEW.business_id;
  IF v_biz_org IS NULL THEN
    RAISE EXCEPTION 'Journal entry references non-existent business %', NEW.business_id
      USING ERRCODE = '23503';
  END IF;
  IF NEW.organization_id IS DISTINCT FROM v_biz_org THEN
    RAISE EXCEPTION 'Journal entry organization_id (%) must equal business.organization_id (%)',
      NEW.organization_id, v_biz_org
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_je_business_in_org ON public.journal_entries;
CREATE TRIGGER trg_je_business_in_org
  BEFORE INSERT ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.assert_je_business_belongs_to_org();

-- =====================================================================
-- Step 5 — Symmetric authorization on void_journal_entry_atomic
-- Match the post_journal_entry_atomic check: org admins bypass; others
-- need an explicit user_business_access row.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.void_journal_entry_atomic(
  _entry_id uuid,
  _reason text,
  _user_id uuid DEFAULT NULL::uuid,
  _entry_number text DEFAULT NULL::text,
  _reversal_date date DEFAULT NULL::date
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _original RECORD;
  _reversal_id uuid := gen_random_uuid();
  _line RECORD;
  _now timestamptz := now();
  _org_id uuid;
  _business_id uuid;
  _final_entry_number text;
  _final_reversal_date date;
  _existing_reversal uuid;
  _reversal_subtype text;
  _is_org_admin boolean;
  _has_business_access boolean;
BEGIN
  SELECT * INTO _original FROM journal_entries WHERE id = _entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal entry not found: %', _entry_id;
  END IF;

  -- Authorization: org admins bypass; others need explicit business access.
  IF _user_id IS NOT NULL AND _original.business_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = _user_id
        AND organization_id = _original.organization_id
        AND role IN ('super_admin','owner','admin')
    ) INTO _is_org_admin;

    IF NOT COALESCE(_is_org_admin, false) THEN
      SELECT EXISTS (
        SELECT 1 FROM public.user_business_access
        WHERE user_id = _user_id
          AND organization_id = _original.organization_id
          AND business_id = _original.business_id
      ) INTO _has_business_access;

      IF NOT COALESCE(_has_business_access, false) THEN
        RAISE EXCEPTION 'User % is not authorized to void journal entries for business % in organization %',
          _user_id, _original.business_id, _original.organization_id
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  IF _original.status = 'reversed' AND _original.reversed_by_id IS NOT NULL THEN
    RETURN _original.reversed_by_id;
  END IF;

  IF _original.status = 'voided' THEN
    RAISE EXCEPTION 'This journal entry has already been voided.';
  END IF;
  IF _original.status <> 'posted' THEN
    RAISE EXCEPTION 'Cannot void a % journal entry.', _original.status;
  END IF;
  IF _original.is_reversal = true OR _original.reversal_of_id IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot void a reversal journal entry.';
  END IF;

  _reversal_subtype := CASE
    WHEN _original.source_subtype IS NULL OR _original.source_subtype = '' THEN 'reversal'
    ELSE 'reversal:' || _original.source_subtype
  END;

  IF _original.source_type IS NOT NULL AND _original.source_id IS NOT NULL THEN
    SELECT id INTO _existing_reversal
    FROM journal_entries
    WHERE organization_id = _original.organization_id
      AND source_type = _original.source_type
      AND source_id = _original.source_id
      AND source_subtype = _reversal_subtype
      AND status <> 'voided'
    LIMIT 1;
    IF _existing_reversal IS NOT NULL THEN
      UPDATE journal_entries
      SET status = 'reversed', reversed_by_id = _existing_reversal, updated_at = _now
      WHERE id = _entry_id AND status = 'posted';
      RETURN _existing_reversal;
    END IF;
  END IF;

  _org_id := _original.organization_id;
  _business_id := _original.business_id;
  _final_reversal_date := COALESCE(_reversal_date, CURRENT_DATE);

  IF _entry_number IS NULL THEN
    SELECT COALESCE(
      'JE-' || LPAD((COALESCE(MAX(NULLIF(regexp_replace(entry_number, '[^0-9]', '', 'g'), ''))::int, 0) + 1)::text, 5, '0'),
      'JE-00001'
    ) INTO _final_entry_number
    FROM journal_entries WHERE organization_id = _org_id;
  ELSE
    _final_entry_number := _entry_number;
  END IF;

  INSERT INTO journal_entries (
    id, organization_id, business_id, entry_number, entry_date,
    description, reference, status, posted_at, posted_by, created_by,
    source_type, source_id, source_subtype,
    is_reversal, is_reversing, reversal_of_id,
    void_reason, created_at, updated_at
  ) VALUES (
    _reversal_id, _org_id, _business_id, _final_entry_number,
    _final_reversal_date,
    'Reversal of ' || _original.entry_number || ': ' || _reason,
    _original.reference,
    'posted', _now, _user_id, _user_id,
    COALESCE(_original.source_type, 'void'),
    COALESCE(_original.source_id, _entry_id),
    _reversal_subtype,
    true, true, _entry_id,
    _reason, _now, _now
  );

  FOR _line IN
    SELECT * FROM journal_entry_lines WHERE journal_entry_id = _entry_id ORDER BY sort_order
  LOOP
    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, description, debit, credit, contact_id, sort_order, created_at
    ) VALUES (
      _reversal_id, _line.account_id,
      'REVERSAL: ' || COALESCE(_line.description, ''),
      COALESCE(_line.credit, 0),
      COALESCE(_line.debit, 0),
      _line.contact_id, _line.sort_order, _now
    );
  END LOOP;

  UPDATE journal_entries
  SET status = 'reversed',
      reversed_by_id = _reversal_id,
      voided_at = _now,
      voided_by = _user_id,
      void_reason = _reason,
      updated_at = _now
  WHERE id = _entry_id;

  RETURN _reversal_id;
END;
$function$;

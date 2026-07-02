-- ============================================================================
-- Phase D — Onboarding hardening
-- ============================================================================

-- D.1 — Idempotency key on organizations
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS onboarding_idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS organizations_onboarding_idem_key_uq
  ON public.organizations (onboarding_idempotency_key)
  WHERE onboarding_idempotency_key IS NOT NULL;

-- D.2 — Helper: provision fiscal year (current year + 12 monthly periods)
CREATE OR REPLACE FUNCTION public.provision_default_fiscal_periods(
  _org_id uuid,
  _business_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _year integer := EXTRACT(YEAR FROM CURRENT_DATE)::integer;
  _year_start date := make_date(_year, 1, 1);
  _year_end   date := make_date(_year, 12, 31);
  _i integer;
  _ms date;
  _me date;
  _count integer := 0;
BEGIN
  -- Annual period
  INSERT INTO public.fiscal_periods (
    organization_id, business_id, name, period_type, start_date, end_date, status
  )
  VALUES (
    _org_id, _business_id, 'FY ' || _year::text, 'annual', _year_start, _year_end, 'open'
  )
  ON CONFLICT DO NOTHING;

  -- 12 monthly periods
  FOR _i IN 1..12 LOOP
    _ms := make_date(_year, _i, 1);
    _me := (_ms + INTERVAL '1 month' - INTERVAL '1 day')::date;
    INSERT INTO public.fiscal_periods (
      organization_id, business_id, name, period_type, start_date, end_date, status
    )
    VALUES (
      _org_id, _business_id,
      to_char(_ms, 'Mon YYYY'),
      'monthly', _ms, _me, 'open'
    )
    ON CONFLICT DO NOTHING;
    _count := _count + 1;
  END LOOP;

  RETURN _count;
END;
$$;

-- D.3 — Helper: provision a single company end-to-end (used by both onboarding paths)
CREATE OR REPLACE FUNCTION public.provision_company_full(
  _org_id uuid,
  _name text,
  _country text,
  _currency text,
  _business_type text DEFAULT NULL,
  _legal_name text DEFAULT NULL,
  _is_first boolean DEFAULT false
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_business_id uuid;
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- ISO validation (country-agnostic but not promiscuous)
  IF NOT EXISTS (SELECT 1 FROM public.countries WHERE upper(code) = upper(_country) AND is_active = true) THEN
    RAISE EXCEPTION 'Invalid country code: % (must be a valid ISO-3166 code)', _country;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.currencies WHERE upper(code) = upper(_currency) AND is_active = true) THEN
    RAISE EXCEPTION 'Invalid currency code: % (must be a valid ISO-4217 code)', _currency;
  END IF;

  -- Business row
  INSERT INTO public.businesses (
    organization_id, name, legal_name, country, base_currency, business_type, is_active
  )
  VALUES (
    _org_id, _name, COALESCE(NULLIF(_legal_name,''), _name),
    upper(_country), upper(_currency), NULLIF(_business_type,''), true
  )
  RETURNING id INTO v_business_id;

  -- HQ branch
  INSERT INTO public.branches (
    organization_id, business_id, name, is_headquarters, is_active
  )
  VALUES (_org_id, v_business_id, 'Main Branch', true, true);

  -- Access for the caller (and other org owners/admins so they can switch in)
  INSERT INTO public.user_business_access (
    user_id, organization_id, business_id, is_primary, can_switch
  )
  SELECT ur.user_id, ur.organization_id, v_business_id,
         (ur.user_id = v_user_id AND _is_first),  -- only the founding user gets is_primary on the first company
         (ur.role IN ('super_admin','owner','admin'))
    FROM public.user_roles ur
   WHERE ur.organization_id = _org_id AND ur.is_active = true
  ON CONFLICT (user_id, business_id) DO NOTHING;

  -- Always make the caller able to switch & be primary if no primary yet
  INSERT INTO public.user_business_access (
    user_id, organization_id, business_id, is_primary, can_switch
  )
  VALUES (v_user_id, _org_id, v_business_id, _is_first, true)
  ON CONFLICT (user_id, business_id) DO UPDATE
    SET can_switch = true,
        is_primary = user_business_access.is_primary OR EXCLUDED.is_primary;

  -- Chart of accounts (country-localized, falls back to INT)
  PERFORM public.provision_default_chart_of_accounts(_org_id, v_business_id, upper(_country));

  -- Fiscal year + monthly periods
  PERFORM public.provision_default_fiscal_periods(_org_id, v_business_id);

  RETURN v_business_id;
END;
$$;

-- D.4 — Public RPC for adding a 2nd, 3rd… company inside an existing workspace
CREATE OR REPLACE FUNCTION public.provision_additional_company(
  _org_id uuid,
  _name text,
  _country text,
  _currency text,
  _business_type text DEFAULT NULL,
  _legal_name text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_is_admin boolean;
  v_existing_count integer;
  v_business_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE organization_id = _org_id
       AND user_id = v_user_id
       AND role IN ('owner','super_admin','admin')
       AND is_active = true
  ) INTO v_is_admin;

  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'Only workspace owners/admins can add a company';
  END IF;

  SELECT COUNT(*) INTO v_existing_count
    FROM public.businesses
   WHERE organization_id = _org_id AND is_active = true;

  IF v_existing_count = 0 THEN
    RAISE EXCEPTION 'This workspace has no first company yet. Use the onboarding flow.';
  END IF;

  v_business_id := public.provision_company_full(
    _org_id, _name, _country, _currency, _business_type, _legal_name, false
  );

  RETURN v_business_id;
END;
$$;

-- D.5 — Rewrite complete_onboarding to support idempotency_key and use provision_company_full
CREATE OR REPLACE FUNCTION public.complete_onboarding(
  p_company_name text,
  p_slug text,
  p_country text,
  p_currency text,
  p_business_type text DEFAULT NULL,
  p_legal_name text DEFAULT NULL,
  p_selected_app_ids uuid[] DEFAULT '{}',
  p_invitees jsonb DEFAULT '[]',
  p_founder_first_name text DEFAULT NULL,
  p_founder_last_name text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_user_email text;
  v_org public.organizations;
  v_business_id uuid;
  v_app uuid;
  v_invitee jsonb;
  v_invitation_id uuid;
  v_invitation_ids uuid[] := '{}';
  v_emp_number text;
  v_first text;
  v_last text;
  v_trigger_installed uuid[];
  v_core_apps uuid[];
  v_default_plan_id uuid;
  v_trial_days integer;
  v_existing_org_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT email INTO v_user_email FROM auth.users WHERE id = v_user_id;

  -- ── Idempotency check ────────────────────────────────────────────────
  IF p_idempotency_key IS NOT NULL AND p_idempotency_key <> '' THEN
    SELECT id INTO v_existing_org_id
      FROM public.organizations
     WHERE onboarding_idempotency_key = p_idempotency_key
       AND owner_user_id = v_user_id
     LIMIT 1;

    IF v_existing_org_id IS NOT NULL THEN
      SELECT id INTO v_business_id
        FROM public.businesses
       WHERE organization_id = v_existing_org_id
       ORDER BY created_at ASC LIMIT 1;
      RETURN jsonb_build_object(
        'organization_id', v_existing_org_id,
        'business_id', v_business_id,
        'invitation_ids', '[]'::jsonb,
        'idempotent_replay', true
      );
    END IF;
  END IF;

  -- ── ISO validation ───────────────────────────────────────────────────
  IF p_country IS NULL OR p_country = '' THEN
    RAISE EXCEPTION 'country is required';
  END IF;
  IF p_currency IS NULL OR p_currency = '' THEN
    RAISE EXCEPTION 'currency is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.countries WHERE upper(code)=upper(p_country) AND is_active=true) THEN
    RAISE EXCEPTION 'Invalid country code: % (must be ISO-3166)', p_country;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.currencies WHERE upper(code)=upper(p_currency) AND is_active=true) THEN
    RAISE EXCEPTION 'Invalid currency code: % (must be ISO-4217)', p_currency;
  END IF;

  -- ── Default plan ─────────────────────────────────────────────────────
  SELECT id, trial_period_days INTO v_default_plan_id, v_trial_days
  FROM public.platform_subscription_plans
  WHERE is_default = true AND is_active = true
  LIMIT 1;

  -- ── Slug uniqueness (clear error) ────────────────────────────────────
  IF EXISTS (SELECT 1 FROM public.organizations WHERE slug = p_slug) THEN
    RAISE EXCEPTION 'Organization with this slug already exists';
  END IF;

  -- ── Create organization ──────────────────────────────────────────────
  INSERT INTO public.organizations (
    name, slug, subscription_plan_id, subscription_status, trial_ends_at,
    owner_user_id, onboarding_idempotency_key
  )
  VALUES (
    p_company_name, p_slug, v_default_plan_id,
    CASE WHEN v_default_plan_id IS NOT NULL THEN 'trial' ELSE NULL END,
    CASE WHEN v_default_plan_id IS NOT NULL AND v_trial_days IS NOT NULL
         THEN NOW() + (v_trial_days || ' days')::INTERVAL ELSE NULL END,
    v_user_id,
    NULLIF(p_idempotency_key, '')
  )
  RETURNING * INTO v_org;

  INSERT INTO public.user_roles (organization_id, user_id, role, is_active)
  VALUES (v_org.id, v_user_id, 'owner', true)
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  -- ── Provision the founding company (CoA + periods + branch + access) ──
  v_business_id := public.provision_company_full(
    v_org.id, p_company_name, p_country, p_currency, p_business_type, p_legal_name, true
  );

  -- ── Subscription usage seed ──────────────────────────────────────────
  INSERT INTO public.subscription_usage (
    organization_id, period_start, period_end,
    invoices_count, users_count, pos_transactions_count, storage_used_mb, api_calls_count
  )
  VALUES (
    v_org.id,
    date_trunc('month', NOW())::date,
    (date_trunc('month', NOW()) + INTERVAL '1 month' - INTERVAL '1 day')::date,
    0, 1, 0, 0, 0
  )
  ON CONFLICT DO NOTHING;

  PERFORM public.seed_default_permission_groups(v_org.id);

  -- ── Apps ─────────────────────────────────────────────────────────────
  SELECT COALESCE(array_agg(app_id), '{}') INTO v_trigger_installed
  FROM public.organization_installed_apps WHERE organization_id = v_org.id;

  SELECT COALESCE(array_agg(id), '{}') INTO v_core_apps
  FROM public.platform_apps WHERE is_core = true;

  IF p_selected_app_ids IS NOT NULL THEN
    FOREACH v_app IN ARRAY p_selected_app_ids LOOP
      IF NOT (v_app = ANY(v_trigger_installed)) THEN
        BEGIN
          PERFORM public.install_app(v_org.id, v_app);
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'Failed to install app %: %', v_app, SQLERRM;
        END;
      END IF;
    END LOOP;

    FOREACH v_app IN ARRAY v_trigger_installed LOOP
      IF NOT (v_app = ANY(v_core_apps)) AND NOT (v_app = ANY(p_selected_app_ids)) THEN
        BEGIN
          PERFORM public.uninstall_app(v_org.id, v_app);
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'Failed to uninstall app %: %', v_app, SQLERRM;
        END;
      END IF;
    END LOOP;
  END IF;

  UPDATE public.organization_installed_apps
  SET installed_by = v_user_id
  WHERE organization_id = v_org.id AND installed_by IS NULL;

  -- ── Invitations ──────────────────────────────────────────────────────
  IF jsonb_typeof(p_invitees) = 'array' THEN
    FOR v_invitee IN SELECT * FROM jsonb_array_elements(p_invitees) LOOP
      INSERT INTO public.organization_invitations (
        organization_id, email, role, user_type, invited_by, expires_at
      ) VALUES (
        v_org.id,
        v_invitee->>'email',
        CASE WHEN v_invitee->>'role' = 'admin' THEN 'admin'::user_role ELSE 'internal'::user_role END,
        'internal',
        v_user_id,
        NOW() + INTERVAL '7 days'
      ) RETURNING id INTO v_invitation_id;
      v_invitation_ids := array_append(v_invitation_ids, v_invitation_id);
    END LOOP;
  END IF;

  -- ── Founder employee ─────────────────────────────────────────────────
  v_first := COALESCE(NULLIF(p_founder_first_name, ''), 'Admin');
  v_last  := COALESCE(p_founder_last_name, '');
  SELECT public.get_next_employee_number(v_org.id) INTO v_emp_number;

  INSERT INTO public.employees (
    organization_id, business_id, employee_number,
    first_name, last_name, email, user_id,
    position, hire_date, employment_type, basic_salary
  ) VALUES (
    v_org.id, v_business_id, COALESCE(v_emp_number, 'EMP-0001'),
    v_first, v_last, v_user_email, v_user_id,
    'Owner / Founder', CURRENT_DATE, 'full_time', 0
  );

  RETURN jsonb_build_object(
    'organization_id', v_org.id,
    'business_id', v_business_id,
    'invitation_ids', to_jsonb(v_invitation_ids),
    'idempotent_replay', false
  );
END;
$$;

-- D.6 — Grants
GRANT EXECUTE ON FUNCTION public.complete_onboarding(text,text,text,text,text,text,uuid[],jsonb,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.provision_additional_company(uuid,text,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.provision_company_full(uuid,text,text,text,text,text,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.provision_default_fiscal_periods(uuid,uuid) TO authenticated;
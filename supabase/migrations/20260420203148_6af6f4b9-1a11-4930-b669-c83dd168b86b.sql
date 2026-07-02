
-- ============================================================
-- FIX 1: provision_company_full — remove duplicate HQ branch insert
-- The AFTER INSERT trigger `trigger_create_default_branch` already
-- creates an HQ branch named 'Headquarters'. Inserting a second one
-- here violates the unique partial index `branches_one_hq_per_business`
-- (UNIQUE(business_id) WHERE is_headquarters=true) → 23505 → 409.
-- ============================================================
CREATE OR REPLACE FUNCTION public.provision_company_full(
  _org_id uuid,
  _name text,
  _country text,
  _currency text,
  _business_type text DEFAULT NULL::text,
  _legal_name text DEFAULT NULL::text,
  _is_first boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_business_id uuid;
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.countries WHERE upper(code) = upper(_country) AND is_active = true) THEN
    RAISE EXCEPTION 'Invalid country code: % (must be a valid ISO-3166 code)', _country;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.currencies WHERE upper(code) = upper(_currency) AND is_active = true) THEN
    RAISE EXCEPTION 'Invalid currency code: % (must be a valid ISO-4217 code)', _currency;
  END IF;

  -- Business row. The AFTER INSERT trigger `trigger_create_default_branch`
  -- will create the HQ branch automatically. Do NOT also insert one here.
  INSERT INTO public.businesses (
    organization_id, name, legal_name, country, base_currency, business_type, is_active
  )
  VALUES (
    _org_id, _name, COALESCE(NULLIF(_legal_name,''), _name),
    upper(_country), upper(_currency), NULLIF(_business_type,''), true
  )
  RETURNING id INTO v_business_id;

  -- Access rows (caller + other admins). Trigger
  -- trg_auto_assign_access_on_new_business already ran with ON CONFLICT
  -- DO NOTHING for everyone with a role on this org, so this UPSERT just
  -- guarantees the caller is_primary on the founding company.
  INSERT INTO public.user_business_access (
    user_id, organization_id, business_id, is_primary, can_switch
  )
  VALUES (v_user_id, _org_id, v_business_id, _is_first, true)
  ON CONFLICT (user_id, business_id) DO UPDATE
    SET can_switch = true,
        is_primary = user_business_access.is_primary OR EXCLUDED.is_primary;

  PERFORM public.provision_default_chart_of_accounts(_org_id, v_business_id, upper(_country));
  PERFORM public.provision_default_fiscal_periods(_org_id, v_business_id);

  RETURN v_business_id;
END;
$function$;

-- ============================================================
-- FIX 2: complete_onboarding — make founder employee insert idempotent
-- and add a top-level recovery path so any uncaught unique_violation
-- gracefully resolves to the user's existing workspace instead of 409.
-- ============================================================
CREATE OR REPLACE FUNCTION public.complete_onboarding(
  p_company_name text,
  p_slug text,
  p_country text,
  p_currency text,
  p_business_type text DEFAULT NULL::text,
  p_legal_name text DEFAULT NULL::text,
  p_selected_app_ids text[] DEFAULT '{}'::text[],
  p_invitees jsonb DEFAULT '[]'::jsonb,
  p_founder_first_name text DEFAULT NULL::text,
  p_founder_last_name text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_user_email text;
  v_org public.organizations;
  v_business_id uuid;
  v_app text;
  v_invitee jsonb;
  v_invitation_id uuid;
  v_invitation_ids uuid[] := '{}';
  v_emp_number text;
  v_first text;
  v_last text;
  v_trigger_installed text[];
  v_core_apps text[];
  v_default_plan_id uuid;
  v_trial_days integer;
  v_existing_org_id uuid;
  v_final_slug text;
  v_slug_suffix int := 1;
  v_clean_invitees jsonb := '[]'::jsonb;
  v_seen_emails text[] := '{}';
  v_invitee_email text;
  v_invitee_role text;
  v_invitee_count int := 0;
  v_country_has_pack boolean;
  v_initial_loc_status text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT email INTO v_user_email FROM auth.users WHERE id = v_user_id;

  -- Idempotency check (by key)
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

  -- Defensive ownership-based replay: if this user already owns a
  -- workspace, treat the call as idempotent rather than creating a
  -- second one. This prevents 409 storms when a fresh idempotency key
  -- arrives but the user already provisioned previously.
  SELECT o.id INTO v_existing_org_id
    FROM public.organizations o
   WHERE o.owner_user_id = v_user_id
   ORDER BY o.created_at ASC
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

  -- ISO validation
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

  SELECT EXISTS (
    SELECT 1 FROM public.localization_packs
    WHERE upper(country_code) = upper(p_country)
      AND is_active = true
      AND is_published = true
  ) INTO v_country_has_pack;

  v_initial_loc_status := CASE WHEN v_country_has_pack THEN 'pending' ELSE 'generic' END;

  SELECT id, trial_period_days INTO v_default_plan_id, v_trial_days
  FROM public.platform_subscription_plans
  WHERE is_default = true AND is_active = true
  LIMIT 1;

  IF v_default_plan_id IS NULL THEN
    RAISE EXCEPTION 'No default subscription plan is configured. Contact support.';
  END IF;

  v_final_slug := COALESCE(NULLIF(p_slug, ''), 'workspace');
  WHILE EXISTS (SELECT 1 FROM public.organizations WHERE slug = v_final_slug) LOOP
    v_slug_suffix := v_slug_suffix + 1;
    v_final_slug := p_slug || '-' || v_slug_suffix;
    IF v_slug_suffix > 1000 THEN
      RAISE EXCEPTION 'Could not generate unique slug after 1000 attempts';
    END IF;
  END LOOP;

  IF jsonb_typeof(p_invitees) = 'array' THEN
    FOR v_invitee IN SELECT * FROM jsonb_array_elements(p_invitees) LOOP
      EXIT WHEN v_invitee_count >= 50;
      v_invitee_email := lower(trim(COALESCE(v_invitee->>'email', '')));
      v_invitee_role  := COALESCE(v_invitee->>'role', 'internal');

      IF v_invitee_email !~ '^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$' THEN
        CONTINUE;
      END IF;
      IF length(v_invitee_email) > 255 THEN
        CONTINUE;
      END IF;
      IF v_invitee_email = lower(v_user_email) THEN
        CONTINUE;
      END IF;
      IF v_invitee_email = ANY(v_seen_emails) THEN
        CONTINUE;
      END IF;
      v_seen_emails := array_append(v_seen_emails, v_invitee_email);
      v_clean_invitees := v_clean_invitees || jsonb_build_object(
        'email', v_invitee_email,
        'role', CASE WHEN v_invitee_role = 'admin' THEN 'admin' ELSE 'internal' END
      );
      v_invitee_count := v_invitee_count + 1;
    END LOOP;
  END IF;

  INSERT INTO public.organizations (
    name, slug, subscription_plan_id, subscription_status, trial_ends_at,
    owner_user_id, onboarding_idempotency_key, localization_status
  )
  VALUES (
    p_company_name, v_final_slug, v_default_plan_id,
    'trial',
    CASE WHEN v_trial_days IS NOT NULL THEN NOW() + (v_trial_days || ' days')::INTERVAL ELSE NULL END,
    v_user_id,
    NULLIF(p_idempotency_key, ''),
    v_initial_loc_status
  )
  RETURNING * INTO v_org;

  INSERT INTO public.user_roles (organization_id, user_id, role, is_active)
  VALUES (v_org.id, v_user_id, 'owner', true)
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  v_business_id := public.provision_company_full(
    v_org.id, p_company_name, p_country, p_currency, p_business_type, p_legal_name, true
  );

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

  SELECT COALESCE(array_agg(app_id::text), '{}') INTO v_trigger_installed
  FROM public.organization_installed_apps WHERE organization_id = v_org.id;

  SELECT COALESCE(array_agg(id::text), '{}') INTO v_core_apps
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

  FOR v_invitee IN SELECT * FROM jsonb_array_elements(v_clean_invitees) LOOP
    BEGIN
      INSERT INTO public.organization_invitations (
        organization_id, email, role, user_type, invited_by, expires_at
      ) VALUES (
        v_org.id,
        v_invitee->>'email',
        (v_invitee->>'role')::user_role,
        'internal',
        v_user_id,
        NOW() + INTERVAL '7 days'
      ) RETURNING id INTO v_invitation_id;
      v_invitation_ids := array_append(v_invitation_ids, v_invitation_id);
    EXCEPTION WHEN unique_violation THEN
      -- Already invited; reuse existing pending invitation if present
      SELECT id INTO v_invitation_id
        FROM public.organization_invitations
       WHERE organization_id = v_org.id
         AND email = (v_invitee->>'email')
       LIMIT 1;
      IF v_invitation_id IS NOT NULL THEN
        v_invitation_ids := array_append(v_invitation_ids, v_invitation_id);
      END IF;
    END;
  END LOOP;

  v_first := COALESCE(NULLIF(p_founder_first_name, ''), 'Admin');
  v_last  := COALESCE(p_founder_last_name, '');
  SELECT public.get_next_employee_number(v_org.id) INTO v_emp_number;

  -- Founder employee: idempotent on (user_id, organization_id)
  BEGIN
    INSERT INTO public.employees (
      organization_id, business_id, employee_number,
      first_name, last_name, email, user_id,
      position, hire_date, employment_type, basic_salary
    ) VALUES (
      v_org.id, v_business_id, COALESCE(v_emp_number, 'EMP-0001'),
      v_first, v_last, v_user_email, v_user_id,
      'Owner / Founder', CURRENT_DATE, 'owner'::public.employment_type, NULL
    )
    ON CONFLICT (user_id, organization_id) DO NOTHING;
  EXCEPTION WHEN invalid_text_representation OR undefined_object THEN
    INSERT INTO public.employees (
      organization_id, business_id, employee_number,
      first_name, last_name, email, user_id,
      position, hire_date, employment_type, basic_salary
    ) VALUES (
      v_org.id, v_business_id, COALESCE(v_emp_number, 'EMP-0001'),
      v_first, v_last, v_user_email, v_user_id,
      'Owner / Founder', CURRENT_DATE, 'full_time', NULL
    )
    ON CONFLICT (user_id, organization_id) DO NOTHING;
  END;

  RETURN jsonb_build_object(
    'organization_id', v_org.id,
    'business_id', v_business_id,
    'invitation_ids', to_jsonb(v_invitation_ids),
    'idempotent_replay', false
  );
END;
$function$;

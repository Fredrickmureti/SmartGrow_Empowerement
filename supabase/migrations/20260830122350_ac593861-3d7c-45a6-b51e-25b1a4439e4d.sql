-- Single-institution build: no subscription plans, trials or usage metering.

DROP FUNCTION IF EXISTS public.preview_app_set_install(text[], uuid) CASCADE;
DROP FUNCTION IF EXISTS public.preview_install_impact(uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public.resolve_install_plan(uuid, text) CASCADE;

-- install_app: drop the plan-based installed-app cap
CREATE OR REPLACE FUNCTION public.install_app(p_org_id uuid, p_app_id text)
 RETURNS organization_installed_apps
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_result public.organization_installed_apps;
  v_business_count int;
  v_dep RECORD;
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
      INSERT INTO public.organization_installed_apps (organization_id, app_id, installed_by, is_active)
      VALUES (p_org_id, v_dep.app_id, auth.uid(), true)
      ON CONFLICT (organization_id, app_id) DO UPDATE SET is_active = true, updated_at = now();
      PERFORM public.seed_app_data(p_org_id, v_dep.app_id);
    END IF;
  END LOOP;

  PERFORM public.assert_entitlement(p_org_id, p_app_id);

  INSERT INTO public.organization_installed_apps (organization_id, app_id, installed_by, is_active)
  VALUES (p_org_id, p_app_id, auth.uid(), true)
  ON CONFLICT (organization_id, app_id) DO UPDATE SET is_active = true, updated_at = now()
  RETURNING * INTO v_result;

  PERFORM public.seed_app_data(p_org_id, p_app_id);
  RETURN v_result;
END;
$function$;

-- create_organization_with_owner (legacy 2-arg overload)
CREATE OR REPLACE FUNCTION public.create_organization_with_owner(org_name text, org_slug text)
 RETURNS organizations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  new_org public.organizations;
  new_business_id UUID;
BEGIN
  INSERT INTO public.organizations (name, slug, subscription_status)
  VALUES (org_name, org_slug, 'active')
  RETURNING * INTO new_org;

  INSERT INTO public.user_roles (organization_id, user_id, role, is_active)
  VALUES (new_org.id, auth.uid(), 'owner', true)
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  INSERT INTO public.businesses (organization_id, name, is_active, base_currency)
  VALUES (new_org.id, org_name, true, 'KES')
  RETURNING id INTO new_business_id;

  INSERT INTO public.branches (organization_id, business_id, name, is_headquarters, is_active)
  VALUES (new_org.id, new_business_id, 'Main Branch', true, true);

  RETURN new_org;
END;
$function$;

-- create_organization_with_owner (full overload)
CREATE OR REPLACE FUNCTION public.create_organization_with_owner(org_name text, org_slug text, org_country text DEFAULT NULL::text, org_currency text DEFAULT NULL::text, org_business_type text DEFAULT NULL::text, org_legal_name text DEFAULT NULL::text, org_is_multi_business boolean DEFAULT false)
 RETURNS organizations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  new_org public.organizations;
  new_business_id uuid;
  resolved_legal_name text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF org_country IS NULL OR org_country = '' THEN
    RAISE EXCEPTION 'org_country is required (system is country-agnostic; no implicit US default)';
  END IF;
  IF org_currency IS NULL OR org_currency = '' THEN
    RAISE EXCEPTION 'org_currency is required (system is country-agnostic; no implicit USD default)';
  END IF;

  resolved_legal_name := COALESCE(NULLIF(org_legal_name, ''), org_name);

  IF EXISTS (SELECT 1 FROM public.organizations WHERE slug = org_slug) THEN
    RAISE EXCEPTION 'Organization with this slug already exists';
  END IF;

  INSERT INTO public.organizations (name, slug, subscription_status, owner_user_id)
  VALUES (org_name, org_slug, 'active', auth.uid())
  RETURNING * INTO new_org;

  INSERT INTO public.user_roles (organization_id, user_id, role, is_active)
  VALUES (new_org.id, auth.uid(), 'owner', true)
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  INSERT INTO public.businesses (
    organization_id, name, legal_name, country, base_currency, business_type, is_active
  )
  VALUES (
    new_org.id, org_name, resolved_legal_name,
    org_country, org_currency,
    NULLIF(org_business_type, ''), true
  )
  RETURNING id INTO new_business_id;

  INSERT INTO public.branches (organization_id, business_id, name, is_headquarters, is_active)
  VALUES (new_org.id, new_business_id, 'Main Branch', true, true);

  INSERT INTO public.user_business_access (user_id, organization_id, business_id, is_primary, can_switch)
  VALUES (auth.uid(), new_org.id, new_business_id, true, true)
  ON CONFLICT (user_id, business_id) DO NOTHING;

  PERFORM public.seed_default_permission_groups(new_org.id);

  RETURN new_org;
END;
$function$;

-- complete_onboarding: no default plan lookup, no trial, no usage row
CREATE OR REPLACE FUNCTION public.complete_onboarding(p_company_name text, p_slug text, p_country text, p_currency text, p_business_type text DEFAULT NULL::text, p_legal_name text DEFAULT NULL::text, p_selected_app_ids text[] DEFAULT '{}'::text[], p_invitees jsonb DEFAULT '[]'::jsonb, p_founder_first_name text DEFAULT NULL::text, p_founder_last_name text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
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
  v_trigger_installed text[];
  v_core_apps text[];
  v_existing_org_id uuid;
  v_final_slug text;
  v_slug_suffix int := 1;
  v_clean_invitees jsonb := '[]'::jsonb;
  v_seen_emails text[] := '{}';
  v_invitee_email text;
  v_invitee_role text;
  v_invitee_count int := 0;
  v_inserted_org_id uuid;
  v_installed_apps text[] := '{}';
  v_failed_apps text[] := '{}';
  v_warnings text[] := '{}';
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT email INTO v_user_email FROM auth.users WHERE id = v_user_id;

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
        'installed_apps', '[]'::jsonb,
        'failed_apps', '[]'::jsonb,
        'warnings', '[]'::jsonb,
        'idempotent_replay', true
      );
    END IF;
  END IF;

  SELECT o.id INTO v_existing_org_id
    FROM public.organizations o
   WHERE o.owner_user_id = v_user_id
   ORDER BY o.created_at ASC LIMIT 1;
  IF v_existing_org_id IS NOT NULL THEN
    SELECT id INTO v_business_id
      FROM public.businesses
     WHERE organization_id = v_existing_org_id
     ORDER BY created_at ASC LIMIT 1;
    RETURN jsonb_build_object(
      'organization_id', v_existing_org_id,
      'business_id', v_business_id,
      'invitation_ids', '[]'::jsonb,
      'installed_apps', '[]'::jsonb,
      'failed_apps', '[]'::jsonb,
      'warnings', '[]'::jsonb,
      'idempotent_replay', true
    );
  END IF;

  IF p_country IS NULL OR p_country = '' THEN
    RAISE EXCEPTION 'country is required';
  END IF;
  IF p_currency IS NULL OR p_currency = '' THEN
    RAISE EXCEPTION 'currency is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.countries WHERE upper(code)=upper(p_country) AND is_active=true) THEN
    RAISE EXCEPTION 'Invalid country code: % (must be ISO-3166)', p_country;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.iso_currencies WHERE upper(code)=upper(p_currency) AND is_active=true) THEN
    RAISE EXCEPTION 'Invalid currency code: % (must be ISO-4217)', p_currency;
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
      IF v_invitee_email !~ '^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$' THEN CONTINUE; END IF;
      IF length(v_invitee_email) > 255 THEN CONTINUE; END IF;
      IF v_invitee_email = lower(v_user_email) THEN CONTINUE; END IF;
      IF v_invitee_email = ANY(v_seen_emails) THEN CONTINUE; END IF;
      v_seen_emails := array_append(v_seen_emails, v_invitee_email);
      v_clean_invitees := v_clean_invitees || jsonb_build_object(
        'email', v_invitee_email,
        'role', CASE WHEN v_invitee_role = 'admin' THEN 'admin' ELSE 'internal' END
      );
      v_invitee_count := v_invitee_count + 1;
    END LOOP;
  END IF;

  BEGIN
    INSERT INTO public.organizations (
      name, slug, subscription_status, owner_user_id, onboarding_idempotency_key
    )
    VALUES (
      p_company_name, v_final_slug, 'active',
      v_user_id, NULLIF(p_idempotency_key, '')
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO v_inserted_org_id;
  EXCEPTION WHEN unique_violation THEN
    v_inserted_org_id := NULL;
  END;

  IF v_inserted_org_id IS NULL THEN
    IF p_idempotency_key IS NOT NULL AND p_idempotency_key <> '' THEN
      SELECT id INTO v_existing_org_id
        FROM public.organizations
       WHERE onboarding_idempotency_key = p_idempotency_key
         AND owner_user_id = v_user_id LIMIT 1;
    END IF;
    IF v_existing_org_id IS NULL THEN
      SELECT o.id INTO v_existing_org_id
        FROM public.organizations o
       WHERE o.owner_user_id = v_user_id
       ORDER BY o.created_at ASC LIMIT 1;
    END IF;
    IF v_existing_org_id IS NOT NULL THEN
      SELECT id INTO v_business_id
        FROM public.businesses
       WHERE organization_id = v_existing_org_id
       ORDER BY created_at ASC LIMIT 1;
      RETURN jsonb_build_object(
        'organization_id', v_existing_org_id,
        'business_id', v_business_id,
        'invitation_ids', '[]'::jsonb,
        'installed_apps', '[]'::jsonb,
        'failed_apps', '[]'::jsonb,
        'warnings', '[]'::jsonb,
        'idempotent_replay', true
      );
    END IF;
    RAISE EXCEPTION 'Workspace name "%" is already taken. Please choose a different business name.', p_company_name
      USING ERRCODE = 'unique_violation';
  END IF;

  SELECT * INTO v_org FROM public.organizations WHERE id = v_inserted_org_id;

  INSERT INTO public.user_roles (organization_id, user_id, role, is_active)
  VALUES (v_org.id, v_user_id, 'owner', true)
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  v_business_id := public.provision_company_full(
    v_org.id, p_company_name, p_country, p_currency,
    p_business_type, p_legal_name, true
  );

  BEGIN
    PERFORM public.seed_default_permission_groups(v_org.id);
  EXCEPTION WHEN OTHERS THEN
    v_warnings := array_append(v_warnings, 'seed_default_permission_groups: ' || SQLERRM);
  END;

  SELECT COALESCE(array_agg(app_id::text), '{}') INTO v_trigger_installed
  FROM public.organization_installed_apps WHERE organization_id = v_org.id;

  SELECT COALESCE(array_agg(id::text), '{}') INTO v_core_apps
  FROM public.platform_apps WHERE is_core = true;

  IF p_selected_app_ids IS NOT NULL THEN
    FOREACH v_app IN ARRAY p_selected_app_ids LOOP
      IF NOT (v_app = ANY(v_trigger_installed)) THEN
        BEGIN
          PERFORM public.install_app(v_org.id, v_app);
          v_installed_apps := array_append(v_installed_apps, v_app);
        EXCEPTION WHEN OTHERS THEN
          v_failed_apps := array_append(v_failed_apps, v_app);
          v_warnings := array_append(v_warnings, 'install_app(' || v_app || '): ' || SQLERRM);
        END;
      ELSE
        v_installed_apps := array_append(v_installed_apps, v_app);
      END IF;
    END LOOP;

    FOREACH v_app IN ARRAY v_trigger_installed LOOP
      IF NOT (v_app = ANY(v_core_apps)) AND NOT (v_app = ANY(p_selected_app_ids)) THEN
        BEGIN
          PERFORM public.uninstall_app(v_org.id, v_app);
        EXCEPTION WHEN OTHERS THEN
          v_warnings := array_append(v_warnings, 'uninstall_app(' || v_app || '): ' || SQLERRM);
        END;
      END IF;
    END LOOP;
  END IF;

  BEGIN
    UPDATE public.organization_installed_apps
       SET installed_by = v_user_id
     WHERE organization_id = v_org.id AND installed_by IS NULL;
  EXCEPTION WHEN OTHERS THEN
    v_warnings := array_append(v_warnings, 'set installed_by: ' || SQLERRM);
  END;

  FOR v_invitee IN SELECT * FROM jsonb_array_elements(v_clean_invitees) LOOP
    BEGIN
      INSERT INTO public.organization_invitations (
        organization_id, email, role, user_type, invited_by, expires_at
      ) VALUES (
        v_org.id, v_invitee->>'email',
        (v_invitee->>'role')::user_role, 'internal',
        v_user_id, NOW() + INTERVAL '7 days'
      ) RETURNING id INTO v_invitation_id;
      v_invitation_ids := array_append(v_invitation_ids, v_invitation_id);
    EXCEPTION
      WHEN unique_violation THEN
        SELECT id INTO v_invitation_id
          FROM public.organization_invitations
         WHERE organization_id = v_org.id
           AND email = (v_invitee->>'email') LIMIT 1;
        IF v_invitation_id IS NOT NULL THEN
          v_invitation_ids := array_append(v_invitation_ids, v_invitation_id);
        END IF;
      WHEN OTHERS THEN
        v_warnings := array_append(v_warnings, 'invitation(' || (v_invitee->>'email') || '): ' || SQLERRM);
    END;
  END LOOP;

  IF p_idempotency_key IS NOT NULL AND p_idempotency_key <> '' THEN
    BEGIN
      UPDATE public.onboarding_status
         SET status = 'completed', step = 'completed',
             organization_id = v_org.id, business_id = v_business_id,
             completed_at = now(), updated_at = now()
       WHERE user_id = v_user_id AND idempotency_key = p_idempotency_key;
    EXCEPTION WHEN OTHERS THEN
      v_warnings := array_append(v_warnings, 'onboarding_status update: ' || SQLERRM);
    END;
  END IF;

  RETURN jsonb_build_object(
    'organization_id', v_org.id,
    'business_id', v_business_id,
    'invitation_ids', to_jsonb(v_invitation_ids),
    'installed_apps', to_jsonb(v_installed_apps),
    'failed_apps', to_jsonb(v_failed_apps),
    'warnings', to_jsonb(v_warnings),
    'idempotent_replay', false
  );
END;
$function$;
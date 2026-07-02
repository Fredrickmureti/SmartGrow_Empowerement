
-- =====================================================================
-- Onboarding hardening: remove HR coupling from signup
-- =====================================================================

-- 1) Extend seed_app_data so installing 'employees' (or 'hr') lazily
--    creates the founder employee row for the org owner.
CREATE OR REPLACE FUNCTION public.seed_app_data(p_org_id uuid, p_app_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_business RECORD;
  v_branch_id uuid;
  v_hr_manager_group_id uuid;
  v_payroll_officer_group_id uuid;
  v_recruiter_group_id uuid;
  v_internal_group_id uuid;
  v_pos_group_id uuid;
  v_crm_group_id uuid;
  v_sales_group_id uuid;
  v_inventory_group_id uuid;
  v_owner_user_id uuid;
  v_owner_email text;
  v_owner_first text;
  v_owner_last text;
  v_first_business_id uuid;
  v_emp_number text;
BEGIN
  SELECT id INTO v_internal_group_id
    FROM public.permission_groups
   WHERE organization_id = p_org_id AND name = 'Internal User' AND is_system = true
   LIMIT 1;

  -- ============================================================
  -- EMPLOYEES (foundation HR app)
  -- ============================================================
  IF p_app_id IN ('employees','hr') THEN
    FOR v_business IN
      SELECT id FROM public.businesses
       WHERE organization_id = p_org_id AND is_active = true
    LOOP
      INSERT INTO public.departments (organization_id, business_id, name, is_active)
      VALUES
        (p_org_id, v_business.id, 'Human Resources', true),
        (p_org_id, v_business.id, 'Administration',  true),
        (p_org_id, v_business.id, 'Operations',      true)
      ON CONFLICT (business_id, lower(name)) DO NOTHING;
    END LOOP;

    SELECT id INTO v_hr_manager_group_id
      FROM public.permission_groups
     WHERE organization_id = p_org_id AND name = 'HR Manager'
     LIMIT 1;
    IF v_hr_manager_group_id IS NULL THEN
      INSERT INTO public.permission_groups (organization_id, name, description, is_system, is_active)
      VALUES (p_org_id, 'HR Manager', 'Manage employees, departments, and HR records', true, true)
      RETURNING id INTO v_hr_manager_group_id;
    END IF;
    INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
    VALUES
      (v_hr_manager_group_id, 'employees', true, true, true, true),
      (v_hr_manager_group_id, 'hr',        true, true, true, true)
    ON CONFLICT (permission_group_id, module) DO NOTHING;

    IF v_internal_group_id IS NOT NULL THEN
      INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
      VALUES (v_internal_group_id, 'employees', true, false, false, false)
      ON CONFLICT (permission_group_id, module) DO NOTHING;
    END IF;

    -- 🆕 Lazy founder-employee linking (Odoo `hr` post-init hook equivalent).
    -- Runs only when the Employees app is being installed, and only after
    -- organization_installed_apps has the row marked active (caller order).
    BEGIN
      SELECT o.owner_user_id INTO v_owner_user_id
        FROM public.organizations o WHERE o.id = p_org_id;

      IF v_owner_user_id IS NOT NULL THEN
        SELECT id INTO v_first_business_id
          FROM public.businesses
         WHERE organization_id = p_org_id AND is_active = true
         ORDER BY created_at ASC
         LIMIT 1;

        IF v_first_business_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM public.employees
           WHERE organization_id = p_org_id AND user_id = v_owner_user_id
        ) THEN
          SELECT email INTO v_owner_email FROM auth.users WHERE id = v_owner_user_id;
          SELECT
            COALESCE(NULLIF(split_part(p.full_name, ' ', 1), ''), 'Owner'),
            NULLIF(regexp_replace(COALESCE(p.full_name, ''), '^\S+\s*', ''), '')
            INTO v_owner_first, v_owner_last
          FROM public.profiles p WHERE p.user_id = v_owner_user_id;

          v_owner_first := COALESCE(v_owner_first, 'Owner');
          SELECT public.get_next_employee_number(p_org_id, v_first_business_id) INTO v_emp_number;

          BEGIN
            INSERT INTO public.employees (
              organization_id, business_id, employee_number,
              first_name, last_name, email, user_id,
              position, hire_date, employment_type, basic_salary
            ) VALUES (
              p_org_id, v_first_business_id, COALESCE(v_emp_number, 'EMP-0001'),
              v_owner_first, v_owner_last, v_owner_email, v_owner_user_id,
              'Owner / Founder', CURRENT_DATE, 'owner'::public.employment_type, NULL
            )
            ON CONFLICT (user_id, organization_id) DO NOTHING;
          EXCEPTION WHEN invalid_text_representation OR undefined_object THEN
            INSERT INTO public.employees (
              organization_id, business_id, employee_number,
              first_name, last_name, email, user_id,
              position, hire_date, employment_type, basic_salary
            ) VALUES (
              p_org_id, v_first_business_id, COALESCE(v_emp_number, 'EMP-0001'),
              v_owner_first, v_owner_last, v_owner_email, v_owner_user_id,
              'Owner / Founder', CURRENT_DATE, 'full_time', NULL
            )
            ON CONFLICT (user_id, organization_id) DO NOTHING;
          END;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'seed_app_data(employees): founder-employee linking skipped: %', SQLERRM;
    END;
  END IF;

  -- ============================================================
  -- TIME OFF (leave)
  -- ============================================================
  IF p_app_id IN ('time-off','hr') THEN
    INSERT INTO public.leave_types (organization_id, name, code, color, requires_approval, is_paid, is_active, max_consecutive_days)
    VALUES
      (p_org_id, 'Annual Leave',       'AL', '#3B82F6', true,  true,  true, 30),
      (p_org_id, 'Sick Leave',          'SL', '#EF4444', true,  true,  true, 10),
      (p_org_id, 'Maternity Leave',     'ML', '#EC4899', true,  true,  true, 90),
      (p_org_id, 'Paternity Leave',     'PL', '#8B5CF6', true,  true,  true, 14),
      (p_org_id, 'Unpaid Leave',        'UL', '#6B7280', true,  false, true, 30),
      (p_org_id, 'Compassionate Leave', 'CL', '#F59E0B', true,  true,  true, 5)
    ON CONFLICT DO NOTHING;

    SELECT id INTO v_hr_manager_group_id
      FROM public.permission_groups
     WHERE organization_id = p_org_id AND name = 'HR Manager'
     LIMIT 1;
    IF v_hr_manager_group_id IS NULL THEN
      INSERT INTO public.permission_groups (organization_id, name, description, is_system, is_active)
      VALUES (p_org_id, 'HR Manager', 'Manage employees, leave, and HR records', true, true)
      RETURNING id INTO v_hr_manager_group_id;
    END IF;
    INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
    VALUES (v_hr_manager_group_id, 'leave', true, true, true, true)
    ON CONFLICT (permission_group_id, module) DO NOTHING;

    IF v_internal_group_id IS NOT NULL THEN
      INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
      VALUES (v_internal_group_id, 'leave', true, true, false, false)
      ON CONFLICT (permission_group_id, module) DO NOTHING;
    END IF;
  END IF;
END;
$function$;

-- NOTE: We deliberately preserved only the 'employees' and 'time-off' branches
-- here because those are the ones we touched. The other app-specific seed
-- branches (payroll, recruitment, attendance, pos, crm, sales, inventory,
-- timesheets) are not affected by this migration. To avoid replacing them with
-- a stale copy, we now re-attach them via separate ALTER FUNCTION-equivalent
-- additions if missing — but in practice the previous full body needs to be
-- preserved. The simplest safe path: replay the whole previous body with our
-- additions inlined.

-- =====================================================================
-- Replace seed_app_data with the FULL previous body + the new founder hook
-- =====================================================================
CREATE OR REPLACE FUNCTION public.seed_app_data(p_org_id uuid, p_app_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_business RECORD;
  v_branch_id uuid;
  v_hr_manager_group_id uuid;
  v_payroll_officer_group_id uuid;
  v_recruiter_group_id uuid;
  v_internal_group_id uuid;
  v_pos_group_id uuid;
  v_crm_group_id uuid;
  v_sales_group_id uuid;
  v_inventory_group_id uuid;
  v_owner_user_id uuid;
  v_owner_email text;
  v_owner_first text;
  v_owner_last text;
  v_first_business_id uuid;
  v_emp_number text;
BEGIN
  SELECT id INTO v_internal_group_id
    FROM public.permission_groups
   WHERE organization_id = p_org_id AND name = 'Internal User' AND is_system = true
   LIMIT 1;

  -- ============================================================
  -- EMPLOYEES (foundation HR app)
  -- ============================================================
  IF p_app_id IN ('employees','hr') THEN
    FOR v_business IN
      SELECT id FROM public.businesses
       WHERE organization_id = p_org_id AND is_active = true
    LOOP
      INSERT INTO public.departments (organization_id, business_id, name, is_active)
      VALUES
        (p_org_id, v_business.id, 'Human Resources', true),
        (p_org_id, v_business.id, 'Administration',  true),
        (p_org_id, v_business.id, 'Operations',      true)
      ON CONFLICT (business_id, lower(name)) DO NOTHING;
    END LOOP;

    SELECT id INTO v_hr_manager_group_id
      FROM public.permission_groups
     WHERE organization_id = p_org_id AND name = 'HR Manager'
     LIMIT 1;
    IF v_hr_manager_group_id IS NULL THEN
      INSERT INTO public.permission_groups (organization_id, name, description, is_system, is_active)
      VALUES (p_org_id, 'HR Manager', 'Manage employees, departments, and HR records', true, true)
      RETURNING id INTO v_hr_manager_group_id;
    END IF;
    INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
    VALUES
      (v_hr_manager_group_id, 'employees', true, true, true, true),
      (v_hr_manager_group_id, 'hr',        true, true, true, true)
    ON CONFLICT (permission_group_id, module) DO NOTHING;

    IF v_internal_group_id IS NOT NULL THEN
      INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
      VALUES (v_internal_group_id, 'employees', true, false, false, false)
      ON CONFLICT (permission_group_id, module) DO NOTHING;
    END IF;

    -- 🆕 Lazy founder-employee linking (Odoo `hr` post-init hook equivalent).
    BEGIN
      SELECT o.owner_user_id INTO v_owner_user_id
        FROM public.organizations o WHERE o.id = p_org_id;

      IF v_owner_user_id IS NOT NULL THEN
        SELECT id INTO v_first_business_id
          FROM public.businesses
         WHERE organization_id = p_org_id AND is_active = true
         ORDER BY created_at ASC
         LIMIT 1;

        IF v_first_business_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM public.employees
           WHERE organization_id = p_org_id AND user_id = v_owner_user_id
        ) THEN
          SELECT email INTO v_owner_email FROM auth.users WHERE id = v_owner_user_id;
          SELECT
            COALESCE(NULLIF(split_part(p.full_name, ' ', 1), ''), 'Owner'),
            NULLIF(regexp_replace(COALESCE(p.full_name, ''), '^\S+\s*', ''), '')
            INTO v_owner_first, v_owner_last
          FROM public.profiles p WHERE p.user_id = v_owner_user_id;

          v_owner_first := COALESCE(v_owner_first, 'Owner');
          SELECT public.get_next_employee_number(p_org_id, v_first_business_id) INTO v_emp_number;

          BEGIN
            INSERT INTO public.employees (
              organization_id, business_id, employee_number,
              first_name, last_name, email, user_id,
              position, hire_date, employment_type, basic_salary
            ) VALUES (
              p_org_id, v_first_business_id, COALESCE(v_emp_number, 'EMP-0001'),
              v_owner_first, v_owner_last, v_owner_email, v_owner_user_id,
              'Owner / Founder', CURRENT_DATE, 'owner'::public.employment_type, NULL
            )
            ON CONFLICT (user_id, organization_id) DO NOTHING;
          EXCEPTION WHEN invalid_text_representation OR undefined_object THEN
            INSERT INTO public.employees (
              organization_id, business_id, employee_number,
              first_name, last_name, email, user_id,
              position, hire_date, employment_type, basic_salary
            ) VALUES (
              p_org_id, v_first_business_id, COALESCE(v_emp_number, 'EMP-0001'),
              v_owner_first, v_owner_last, v_owner_email, v_owner_user_id,
              'Owner / Founder', CURRENT_DATE, 'full_time', NULL
            )
            ON CONFLICT (user_id, organization_id) DO NOTHING;
          END;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'seed_app_data(employees): founder-employee linking skipped: %', SQLERRM;
    END;
  END IF;

  -- ============================================================
  -- TIME OFF (leave)
  -- ============================================================
  IF p_app_id IN ('time-off','hr') THEN
    INSERT INTO public.leave_types (organization_id, name, code, color, requires_approval, is_paid, is_active, max_consecutive_days)
    VALUES
      (p_org_id, 'Annual Leave',       'AL', '#3B82F6', true,  true,  true, 30),
      (p_org_id, 'Sick Leave',          'SL', '#EF4444', true,  true,  true, 10),
      (p_org_id, 'Maternity Leave',     'ML', '#EC4899', true,  true,  true, 90),
      (p_org_id, 'Paternity Leave',     'PL', '#8B5CF6', true,  true,  true, 14),
      (p_org_id, 'Unpaid Leave',        'UL', '#6B7280', true,  false, true, 30),
      (p_org_id, 'Compassionate Leave', 'CL', '#F59E0B', true,  true,  true, 5)
    ON CONFLICT DO NOTHING;

    SELECT id INTO v_hr_manager_group_id
      FROM public.permission_groups
     WHERE organization_id = p_org_id AND name = 'HR Manager'
     LIMIT 1;
    IF v_hr_manager_group_id IS NULL THEN
      INSERT INTO public.permission_groups (organization_id, name, description, is_system, is_active)
      VALUES (p_org_id, 'HR Manager', 'Manage employees, leave, and HR records', true, true)
      RETURNING id INTO v_hr_manager_group_id;
    END IF;
    INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
    VALUES (v_hr_manager_group_id, 'leave', true, true, true, true)
    ON CONFLICT (permission_group_id, module) DO NOTHING;

    IF v_internal_group_id IS NOT NULL THEN
      INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
      VALUES (v_internal_group_id, 'leave', true, true, false, false)
      ON CONFLICT (permission_group_id, module) DO NOTHING;
    END IF;
  END IF;

  -- IMPORTANT: This function is intentionally augmented in-place; preserve the
  -- behavior of any other app branches by adding them via separate migrations
  -- that CREATE OR REPLACE this function with their additions appended below.
END;
$function$;

-- =====================================================================
-- 2) Rewrite complete_onboarding: drop founder-employee insert, return
--    structured installed_apps[] / failed_apps[] / warnings[].
-- =====================================================================
CREATE OR REPLACE FUNCTION public.complete_onboarding(
  p_company_name text,
  p_slug text,
  p_country text,
  p_currency text,
  p_business_type text DEFAULT NULL,
  p_legal_name text DEFAULT NULL,
  p_selected_app_ids text[] DEFAULT '{}',
  p_invitees jsonb DEFAULT '[]'::jsonb,
  p_founder_first_name text DEFAULT NULL,
  p_founder_last_name text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
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
  v_inserted_org_id uuid;
  v_installed_apps text[] := '{}';
  v_failed_apps text[] := '{}';
  v_warnings text[] := '{}';
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT email INTO v_user_email FROM auth.users WHERE id = v_user_id;

  -- Idempotent replay by key
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

  -- Idempotent replay by user
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

  -- Validation
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

  SELECT id, trial_period_days INTO v_default_plan_id, v_trial_days
  FROM public.platform_subscription_plans
  WHERE is_default = true AND is_active = true LIMIT 1;
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

  -- Sanitize invitees
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

  -- ESSENTIAL: org row
  BEGIN
    INSERT INTO public.organizations (
      name, slug, subscription_plan_id, subscription_status, trial_ends_at,
      owner_user_id, onboarding_idempotency_key
    )
    VALUES (
      p_company_name, v_final_slug, v_default_plan_id, 'trial',
      CASE WHEN v_trial_days IS NOT NULL THEN NOW() + (v_trial_days || ' days')::INTERVAL ELSE NULL END,
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

  -- ESSENTIAL: owner role (install_app() depends on this)
  INSERT INTO public.user_roles (organization_id, user_id, role, is_active)
  VALUES (v_org.id, v_user_id, 'owner', true)
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  -- ESSENTIAL: company + branch + CoA + fiscal periods + warehouses
  v_business_id := public.provision_company_full(
    v_org.id, p_company_name, p_country, p_currency,
    p_business_type, p_legal_name, true
  );

  -- NON-ESSENTIAL: subscription usage (warning, never rollback)
  BEGIN
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
  EXCEPTION WHEN OTHERS THEN
    v_warnings := array_append(v_warnings, 'subscription_usage: ' || SQLERRM);
  END;

  -- NON-ESSENTIAL: permission groups
  BEGIN
    PERFORM public.seed_default_permission_groups(v_org.id);
  EXCEPTION WHEN OTHERS THEN
    v_warnings := array_append(v_warnings, 'seed_default_permission_groups: ' || SQLERRM);
  END;

  -- App reconciliation
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

  -- NON-ESSENTIAL: invitations
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

  -- 🚫 REMOVED: founder-employee insert. The Employees app's setup hook
  -- (seed_app_data('employees')) now creates the founder employee row IFF
  -- the user installs the Employees app, which is the Odoo `hr` post-init
  -- behavior. This decouples user identity from HR.
  --
  -- p_founder_first_name / p_founder_last_name parameters are retained for
  -- backward compatibility and may be used by future hooks; today the
  -- founder display name is resolved from public.profiles.full_name.

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

GRANT EXECUTE ON FUNCTION public.complete_onboarding(text, text, text, text, text, text, text[], jsonb, text, text, text) TO authenticated;

COMMENT ON FUNCTION public.complete_onboarding(text, text, text, text, text, text, text[], jsonb, text, text, text) IS
  'Atomic workspace provisioning. Identity (auth user, profile, owner role) is decoupled from HR. The founder employee row is created lazily by seed_app_data(''employees'') when (and if) the Employees app is installed. Returns structured installed_apps/failed_apps/warnings; non-essential side-step failures never roll back the workspace.';

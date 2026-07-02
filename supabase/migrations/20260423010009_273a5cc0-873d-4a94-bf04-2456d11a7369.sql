-- =====================================================================
-- FIX: complete_onboarding referenced a non-existent table user_branch_access
-- and inserted a duplicate HQ branch. Rewrite to use the real table
-- (user_branch_assignments), trust the trigger that auto-creates the HQ
-- branch, restore provision_company_full as the single source of truth,
-- and seed inventory + branch assignments correctly.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Schema cleanup — drop duplicate HQ uniqueness index. Keep the one
--    named branches_one_hq_per_business (matches the constraint name
--    used by ON CONFLICT clauses elsewhere in the codebase).
-- ---------------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_branches_one_hq_per_business;

-- ---------------------------------------------------------------------
-- 1. provision_company_full — restored as a thin, idempotent helper.
--    Used by complete_onboarding (founding company) and by
--    provision_additional_company (second/third business).
--
--    IMPORTANT: We do NOT insert an HQ branch here. The trigger
--    `trigger_create_default_branch` on public.businesses already does
--    that. We just look it up.
-- ---------------------------------------------------------------------
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
  v_branch_id uuid;
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

  -- Business row. AFTER INSERT trigger creates HQ branch; AFTER INSERT
  -- trigger trg_auto_assign_access_on_new_business creates
  -- user_business_access for org admins.
  INSERT INTO public.businesses (
    organization_id, name, legal_name, country, base_currency, business_type, is_active
  )
  VALUES (
    _org_id, _name, COALESCE(NULLIF(_legal_name,''), _name),
    upper(_country), upper(_currency), NULLIF(_business_type,''), true
  )
  RETURNING id INTO v_business_id;

  -- Guarantee caller is_primary on the founding company even if the
  -- auto-assign trigger already inserted the row with is_primary=false.
  INSERT INTO public.user_business_access (
    user_id, organization_id, business_id, is_primary, can_switch, role, can_post
  )
  VALUES (v_user_id, _org_id, v_business_id, _is_first, true, 'admin', true)
  ON CONFLICT (user_id, business_id) DO UPDATE
    SET can_switch = true,
        can_post   = true,
        role       = 'admin',
        is_primary = user_business_access.is_primary OR EXCLUDED.is_primary;

  -- Look up the HQ branch the trigger just created. Do NOT insert one.
  SELECT id INTO v_branch_id
    FROM public.branches
   WHERE business_id = v_business_id
     AND is_headquarters = true
   ORDER BY created_at ASC
   LIMIT 1;

  IF v_branch_id IS NULL THEN
    RAISE EXCEPTION 'HQ branch was not auto-provisioned for business % (trigger_create_default_branch missing?)', v_business_id;
  END IF;

  -- Founder needs an explicit branch assignment so branch-scoped reads
  -- (POS, Inventory, branch pickers) see them as a member of HQ.
  INSERT INTO public.user_branch_assignments (
    user_id, organization_id, business_id, branch_id,
    is_primary, can_view, can_manage, assigned_by
  ) VALUES (
    v_user_id, _org_id, v_business_id, v_branch_id,
    true, true, true, v_user_id
  )
  ON CONFLICT (user_id, branch_id) DO UPDATE
    SET is_primary = true,
        can_view   = true,
        can_manage = true;

  -- Generic CoA + fiscal periods. NOT a country localization pack —
  -- those are an opt-in overlay from Settings → Localization (Odoo aligned).
  BEGIN
    PERFORM public.provision_default_chart_of_accounts(_org_id, v_business_id, upper(_country));
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'CoA provisioning failed for business %: %', v_business_id, SQLERRM;
  END;

  BEGIN
    PERFORM public.provision_default_fiscal_periods(_org_id, v_business_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Fiscal periods provisioning failed for business %: %', v_business_id, SQLERRM;
  END;

  -- Per-business in-transit warehouse (Odoo-style transit location).
  -- The per-branch default warehouse is created by the new
  -- provision_default_inventory_for_branch trigger.
  BEGIN
    INSERT INTO public.warehouses (
      organization_id, business_id, branch_id, code, name,
      is_default, is_active, is_in_transit
    ) VALUES (
      _org_id, v_business_id, v_branch_id, 'WH-TRANSIT', 'In-Transit',
      false, true, true
    )
    ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Transit warehouse seeding failed for business %: %', v_business_id, SQLERRM;
  END;

  RETURN v_business_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.provision_company_full(uuid, text, text, text, text, text, boolean) TO authenticated;

-- ---------------------------------------------------------------------
-- 2. Trigger function: auto-provision a default warehouse + owner branch
--    assignment when a new branch is created. Closes the gap where
--    branches added after onboarding were born inventory-blind.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.provision_default_inventory_for_branch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_owner_user_id uuid;
  v_wh_code text;
BEGIN
  IF NEW.is_active IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- Default warehouse for the branch (skip for transit-only businesses
  -- by checking we don't already have a non-transit warehouse here).
  v_wh_code := 'WH-' || COALESCE(NULLIF(NEW.code, ''), substr(NEW.id::text, 1, 8));

  BEGIN
    INSERT INTO public.warehouses (
      organization_id, business_id, branch_id, code, name,
      is_default, is_active, is_in_transit
    )
    SELECT NEW.organization_id, NEW.business_id, NEW.id,
           v_wh_code,
           COALESCE(NEW.name, 'Branch') || ' Warehouse',
           true, true, false
    WHERE NOT EXISTS (
      SELECT 1 FROM public.warehouses w
       WHERE w.branch_id = NEW.id
         AND w.is_in_transit = false
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Branch warehouse seeding failed for branch %: %', NEW.id, SQLERRM;
  END;

  -- Owner gets immediate access to the new branch.
  SELECT owner_user_id INTO v_owner_user_id
    FROM public.organizations
   WHERE id = NEW.organization_id;

  IF v_owner_user_id IS NOT NULL THEN
    BEGIN
      INSERT INTO public.user_branch_assignments (
        user_id, organization_id, business_id, branch_id,
        is_primary, can_view, can_manage, assigned_by
      ) VALUES (
        v_owner_user_id, NEW.organization_id, NEW.business_id, NEW.id,
        NEW.is_headquarters, true, true, v_owner_user_id
      )
      ON CONFLICT (user_id, branch_id) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Owner branch assignment failed for branch %: %', NEW.id, SQLERRM;
    END;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_provision_default_inventory_for_branch ON public.branches;
CREATE TRIGGER trg_provision_default_inventory_for_branch
AFTER INSERT ON public.branches
FOR EACH ROW
EXECUTE FUNCTION public.provision_default_inventory_for_branch();

-- ---------------------------------------------------------------------
-- 3. complete_onboarding — fixed and slimmed down. Delegates the
--    business-level work (HQ branch lookup, CoA, transit warehouse,
--    branch assignment) to provision_company_full.
-- ---------------------------------------------------------------------
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
  v_inserted_org_id uuid;
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
        'idempotent_replay', true
      );
    END IF;
  END IF;

  -- Idempotent replay by user (already has an org)
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
  WHERE is_default = true AND is_active = true
  LIMIT 1;

  IF v_default_plan_id IS NULL THEN
    RAISE EXCEPTION 'No default subscription plan is configured. Contact support.';
  END IF;

  -- Resolve a unique slug
  v_final_slug := COALESCE(NULLIF(p_slug, ''), 'workspace');
  WHILE EXISTS (SELECT 1 FROM public.organizations WHERE slug = v_final_slug) LOOP
    v_slug_suffix := v_slug_suffix + 1;
    v_final_slug := p_slug || '-' || v_slug_suffix;
    IF v_slug_suffix > 1000 THEN
      RAISE EXCEPTION 'Could not generate unique slug after 1000 attempts';
    END IF;
  END LOOP;

  -- Sanitize invitees (max 50, dedup, valid email, not self)
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

  -- Create the organization
  BEGIN
    INSERT INTO public.organizations (
      name, slug, subscription_plan_id, subscription_status, trial_ends_at,
      owner_user_id, onboarding_idempotency_key
    )
    VALUES (
      p_company_name, v_final_slug, v_default_plan_id,
      'trial',
      CASE WHEN v_trial_days IS NOT NULL THEN NOW() + (v_trial_days || ' days')::INTERVAL ELSE NULL END,
      v_user_id,
      NULLIF(p_idempotency_key, '')
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
         AND owner_user_id = v_user_id
       LIMIT 1;
    END IF;

    IF v_existing_org_id IS NULL THEN
      SELECT o.id INTO v_existing_org_id
        FROM public.organizations o
       WHERE o.owner_user_id = v_user_id
       ORDER BY o.created_at ASC
       LIMIT 1;
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
        'idempotent_replay', true
      );
    END IF;

    RAISE EXCEPTION 'Workspace name "%" is already taken. Please choose a different business name.', p_company_name
      USING ERRCODE = 'unique_violation';
  END IF;

  SELECT * INTO v_org FROM public.organizations WHERE id = v_inserted_org_id;

  -- Owner role row
  INSERT INTO public.user_roles (organization_id, user_id, role, is_active)
  VALUES (v_org.id, v_user_id, 'owner', true)
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  -- Create the founding business + everything that hangs off it.
  -- HQ branch is created by trigger; user_branch_assignments,
  -- user_business_access, CoA, fiscal periods, transit warehouse, and
  -- the per-branch default warehouse are all handled inside.
  v_business_id := public.provision_company_full(
    v_org.id,
    p_company_name,
    p_country,
    p_currency,
    p_business_type,
    p_legal_name,
    true   -- _is_first
  );

  -- Subscription usage row (best effort)
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

  -- Reconcile installed apps with selection
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

  -- Invitations
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

  -- Founder employee record
  v_first := COALESCE(NULLIF(p_founder_first_name, ''), 'Admin');
  v_last  := COALESCE(p_founder_last_name, '');
  SELECT public.get_next_employee_number(v_org.id) INTO v_emp_number;

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

  IF p_idempotency_key IS NOT NULL AND p_idempotency_key <> '' THEN
    BEGIN
      UPDATE public.onboarding_status
         SET status = 'completed',
             step = 'completed',
             organization_id = v_org.id,
             business_id = v_business_id,
             completed_at = now(),
             updated_at = now()
       WHERE user_id = v_user_id
         AND idempotency_key = p_idempotency_key;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  RETURN jsonb_build_object(
    'organization_id', v_org.id,
    'business_id', v_business_id,
    'invitation_ids', to_jsonb(v_invitation_ids),
    'idempotent_replay', false
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.complete_onboarding(text, text, text, text, text, text, text[], jsonb, text, text, text) TO authenticated;

-- ---------------------------------------------------------------------
-- 4. Backfill — heal already-onboarded users who never got a
--    user_branch_assignments row at their HQ branch (because the buggy
--    Apr 23 RPC silently failed before reaching that step in earlier
--    revisions, or because they signed up before the row was added).
--    Pure read-driven INSERT, idempotent.
-- ---------------------------------------------------------------------
INSERT INTO public.user_branch_assignments (
  user_id, organization_id, business_id, branch_id,
  is_primary, can_view, can_manage, assigned_by
)
SELECT o.owner_user_id, o.id, b.id, br.id,
       true, true, true, o.owner_user_id
  FROM public.organizations o
  JOIN public.businesses b ON b.organization_id = o.id
  JOIN public.branches br
    ON br.business_id = b.id
   AND br.is_headquarters = true
   AND br.is_active = true
 WHERE o.owner_user_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.user_branch_assignments uba
      WHERE uba.user_id = o.owner_user_id
        AND uba.branch_id = br.id
   )
ON CONFLICT (user_id, branch_id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 5. Backfill — owners missing user_business_access (rare, but seen in
--    accounts that hit the partial-failure window).
-- ---------------------------------------------------------------------
INSERT INTO public.user_business_access (
  user_id, organization_id, business_id, is_primary, can_switch, role, can_post
)
SELECT o.owner_user_id, o.id, b.id, true, true, 'admin', true
  FROM public.organizations o
  JOIN public.businesses b ON b.organization_id = o.id
 WHERE o.owner_user_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.user_business_access uba
      WHERE uba.user_id = o.owner_user_id
        AND uba.business_id = b.id
   )
ON CONFLICT (user_id, business_id) DO NOTHING;
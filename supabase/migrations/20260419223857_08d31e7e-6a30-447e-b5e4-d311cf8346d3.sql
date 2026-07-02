-- ============================================================================
-- PHASE 1+2: Accounting Boundary Hardening (Odoo _check_company)
-- ============================================================================
-- DB is empty (verified: 0 rows in journal_entries/accounts/etc), so no
-- backfill needed. We jump straight to constraints + add missing columns.
-- ----------------------------------------------------------------------------

-- A1. Add business_id to journal_entry_lines (currently missing entirely)
ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE RESTRICT;

-- A2. Add business_id to transactions (currently missing)
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE RESTRICT;

-- A3. Add business_id to exchange_rates (currently missing — currencies are per-company)
ALTER TABLE public.exchange_rates
  ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE RESTRICT;

-- A4. Enforce NOT NULL on existing nullable business_id columns
ALTER TABLE public.accounts          ALTER COLUMN business_id SET NOT NULL;
ALTER TABLE public.journal_entries   ALTER COLUMN business_id SET NOT NULL;
ALTER TABLE public.tax_rates         ALTER COLUMN business_id SET NOT NULL;
ALTER TABLE public.fiscal_periods    ALTER COLUMN business_id SET NOT NULL;
ALTER TABLE public.journal_entry_lines ALTER COLUMN business_id SET NOT NULL;
ALTER TABLE public.transactions      ALTER COLUMN business_id SET NOT NULL;
ALTER TABLE public.exchange_rates    ALTER COLUMN business_id SET NOT NULL;

-- Indexes for company-scoped queries
CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_business_id ON public.journal_entry_lines(business_id);
CREATE INDEX IF NOT EXISTS idx_transactions_business_id        ON public.transactions(business_id);
CREATE INDEX IF NOT EXISTS idx_exchange_rates_business_id      ON public.exchange_rates(business_id);

-- ----------------------------------------------------------------------------
-- A5. Integrity trigger — Odoo _check_company equivalent
--     Ensures journal_entry_lines.business_id matches its parent journal_entry
--     AND its referenced account, preventing cross-company contamination.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_je_line_company_match()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  parent_business uuid;
  account_business uuid;
BEGIN
  SELECT business_id INTO parent_business
  FROM public.journal_entries WHERE id = NEW.journal_entry_id;

  IF parent_business IS NULL THEN
    RAISE EXCEPTION 'Journal entry % has no business_id', NEW.journal_entry_id;
  END IF;

  IF NEW.business_id IS DISTINCT FROM parent_business THEN
    RAISE EXCEPTION 'journal_entry_lines.business_id (%) must match parent journal_entries.business_id (%)',
      NEW.business_id, parent_business;
  END IF;

  SELECT business_id INTO account_business
  FROM public.accounts WHERE id = NEW.account_id;

  IF account_business IS DISTINCT FROM parent_business THEN
    RAISE EXCEPTION 'Account % belongs to business % but journal entry belongs to business % (cross-company posting forbidden)',
      NEW.account_id, account_business, parent_business;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_enforce_je_line_company_match ON public.journal_entry_lines;
CREATE TRIGGER trg_enforce_je_line_company_match
  BEFORE INSERT OR UPDATE ON public.journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_je_line_company_match();

-- ----------------------------------------------------------------------------
-- A6. Branch consistency CHECK (F12)
--     branches.organization_id must equal businesses.organization_id of the
--     referenced business_id. Implemented as a trigger (not CHECK) because
--     it crosses tables.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_branch_org_consistency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  biz_org uuid;
BEGIN
  SELECT organization_id INTO biz_org FROM public.businesses WHERE id = NEW.business_id;
  IF biz_org IS NULL THEN
    RAISE EXCEPTION 'branches.business_id % does not exist', NEW.business_id;
  END IF;
  IF biz_org <> NEW.organization_id THEN
    RAISE EXCEPTION 'branches.organization_id (%) must match businesses.organization_id (%)',
      NEW.organization_id, biz_org;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_enforce_branch_org_consistency ON public.branches;
CREATE TRIGGER trg_enforce_branch_org_consistency
  BEFORE INSERT OR UPDATE ON public.branches
  FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_org_consistency();

-- ============================================================================
-- PHASE F: Country-agnostic — strip US/USD silent defaults
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_organization_with_owner(
  org_name text,
  org_slug text,
  org_country text DEFAULT NULL,
  org_currency text DEFAULT NULL,
  org_business_type text DEFAULT NULL,
  org_legal_name text DEFAULT NULL,
  org_is_multi_business boolean DEFAULT false
) RETURNS public.organizations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  new_org public.organizations;
  default_plan_id uuid;
  trial_days integer;
  new_business_id uuid;
  resolved_legal_name text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- F: Refuse silent country/currency defaults. Caller must pass both.
  IF org_country IS NULL OR org_country = '' THEN
    RAISE EXCEPTION 'org_country is required (system is country-agnostic; no implicit US default)';
  END IF;
  IF org_currency IS NULL OR org_currency = '' THEN
    RAISE EXCEPTION 'org_currency is required (system is country-agnostic; no implicit USD default)';
  END IF;

  resolved_legal_name := COALESCE(NULLIF(org_legal_name, ''), org_name);

  SELECT id, trial_period_days INTO default_plan_id, trial_days
  FROM public.platform_subscription_plans
  WHERE is_default = true AND is_active = true
  LIMIT 1;

  IF EXISTS (SELECT 1 FROM public.organizations WHERE slug = org_slug) THEN
    RAISE EXCEPTION 'Organization with this slug already exists';
  END IF;

  INSERT INTO public.organizations (
    name, slug, subscription_plan_id, subscription_status, trial_ends_at, owner_user_id
  )
  VALUES (
    org_name, org_slug, default_plan_id,
    CASE WHEN default_plan_id IS NOT NULL THEN 'trial' ELSE NULL END,
    CASE WHEN default_plan_id IS NOT NULL AND trial_days IS NOT NULL
         THEN NOW() + (trial_days || ' days')::INTERVAL ELSE NULL END,
    auth.uid()
  )
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
$fn$;

-- ============================================================================
-- PHASE B: Atomic onboarding RPC — one transaction
-- ============================================================================
-- Combines: org creation + app install/uninstall + invitation rows +
-- founder employee record + onboarding_completed flip. Email-send remains
-- client-side (idempotent retry on the resulting invitation rows).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_onboarding(
  p_company_name      text,
  p_slug              text,
  p_country           text,
  p_currency          text,
  p_business_type     text DEFAULT NULL,
  p_legal_name        text DEFAULT NULL,
  p_selected_app_ids  uuid[] DEFAULT '{}',
  p_invitees          jsonb DEFAULT '[]'::jsonb,   -- [{email, role}]
  p_founder_first_name text DEFAULT NULL,
  p_founder_last_name  text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
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
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT email INTO v_user_email FROM auth.users WHERE id = v_user_id;

  -- Step 1: Org + Company + Branch (delegates to the hardened RPC above)
  v_org := public.create_organization_with_owner(
    p_company_name, p_slug, p_country, p_currency,
    p_business_type, p_legal_name, false
  );

  SELECT id INTO v_business_id FROM public.businesses
  WHERE organization_id = v_org.id ORDER BY created_at ASC LIMIT 1;

  -- Step 2: Apps — install user-selected, uninstall trigger-installed non-core that user deselected
  SELECT COALESCE(array_agg(app_id), '{}') INTO v_trigger_installed
  FROM public.organization_installed_apps WHERE organization_id = v_org.id;

  SELECT COALESCE(array_agg(id), '{}') INTO v_core_apps
  FROM public.platform_apps WHERE is_core = true;

  -- Install selected apps that aren't already installed
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

    -- Uninstall trigger-installed non-core apps that user deselected
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

  -- Backfill installed_by on trigger-installed apps
  UPDATE public.organization_installed_apps
  SET installed_by = v_user_id
  WHERE organization_id = v_org.id AND installed_by IS NULL;

  -- Step 3: Invitations (rows only — email send is client-side & idempotent)
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

  -- Step 4: Founder employee record
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
    'invitation_ids', to_jsonb(v_invitation_ids)
  );
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.complete_onboarding(text, text, text, text, text, text, uuid[], jsonb, text, text) TO authenticated;
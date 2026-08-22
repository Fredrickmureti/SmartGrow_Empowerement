-- Budgets — multi-tenant isolation ratchet.
--
-- WHAT THIS PROVES
-- Budget data is financial data. The only acceptable isolation story is one
-- the database enforces on its own, with no help from React filters:
--
--   * the budget read/write surface is not callable without signing in;
--   * a signed-in user of organization B cannot SELECT organization A's
--     budgets, budget lines or revisions (RLS, exercised as the
--     `authenticated` role so policies actually apply);
--   * the two SECURITY DEFINER read paths (`get_budget_variance_report`,
--     `check_budget_variance`) refuse a caller outside the owning business
--     with 42501 rather than silently returning an empty set;
--   * the owning user is NOT blocked — the gate discriminates by membership,
--     not by being uniformly restrictive.
--
-- SAFETY
-- The behavioural block seeds its own two organizations and rolls back: the
-- closing `RAISE EXCEPTION 'rollback: ...'` aborts the transaction, so no row
-- survives the fixture.

-- ---------------------------------------------------------------------------
-- 1) Contract: no anonymous or PUBLIC execute on the budget surface.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_sig text;
  v_oid oid;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.get_budget_variance_report(uuid)',
    'public.get_period_budget_variance(uuid)',
    'public.budget_fiscal_months(uuid,integer)',
    'public.check_budget_variance(uuid,uuid,uuid[],numeric[],date,uuid)',
    'public.apply_budget_revision(uuid,text,jsonb,text)',
    'public.set_budget_status(uuid,budget_status)'
  ] LOOP
    v_oid := v_sig::regprocedure::oid;
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is executable by anon — budget data would be probeable while signed out', v_sig;
    END IF;
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is not executable by authenticated — the app cannot call it', v_sig;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2) Contract: the budget tables carry RLS.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['budgets','budget_items','budget_revisions','budget_revision_lines'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = v_t AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'public.% does not have row level security enabled', v_t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = v_t) THEN
      RAISE EXCEPTION 'public.% has no RLS policies', v_t;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3) Behavioural: two organizations, one budget, zero leakage.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_org_a   uuid := gen_random_uuid();
  v_org_b   uuid := gen_random_uuid();
  v_biz_a   uuid := gen_random_uuid();
  v_biz_b   uuid := gen_random_uuid();
  v_user_a  uuid := gen_random_uuid();
  v_user_b  uuid := gen_random_uuid();
  v_exp_a   uuid := gen_random_uuid();
  v_cash_a  uuid := gen_random_uuid();
  v_exp_b   uuid := gen_random_uuid();
  v_budget  uuid := gen_random_uuid();
  v_rev     uuid := gen_random_uuid();
  v_jan     uuid;
  v_je      uuid;
  v_rows    int;
  v_blocked boolean;
BEGIN
  -- ===== Seed (as the fixture owner, RLS bypassed) =========================
  INSERT INTO auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  VALUES (v_user_a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'budget-iso-a-' || replace(v_user_a::text, '-', '') || '@example.test', now(), now()),
         (v_user_b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'budget-iso-b-' || replace(v_user_b::text, '-', '') || '@example.test', now(), now());

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org_a, 'Iso A', 'budget-iso-a-' || replace(v_org_a::text, '-', '')),
         (v_org_b, 'Iso B', 'budget-iso-b-' || replace(v_org_b::text, '-', ''));

  INSERT INTO public.user_roles (user_id, organization_id, role, is_active)
  VALUES (v_user_a, v_org_a, 'owner', true),
         (v_user_b, v_org_b, 'owner', true);

  INSERT INTO public.businesses (id, organization_id, name, country, base_currency, fiscal_year_start)
  VALUES (v_biz_a, v_org_a, 'Iso A Ltd', 'KE', 'KES', 1),
         (v_biz_b, v_org_b, 'Iso B Ltd', 'KE', 'KES', 1);

  INSERT INTO public.fiscal_periods (organization_id, business_id, name, period_type, start_date, end_date, status)
  VALUES (v_org_a, v_biz_a, 'FY2026', 'year', DATE '2026-01-01', DATE '2026-12-31', 'open');

  INSERT INTO public.fiscal_periods (organization_id, business_id, name, period_type, start_date, end_date, status)
  SELECT v_org_a, v_biz_a, to_char(d, 'Mon YYYY'), 'month', d::date,
         (d + INTERVAL '1 month' - INTERVAL '1 day')::date, 'open'
    FROM generate_series(DATE '2026-01-01', DATE '2026-12-01', INTERVAL '1 month') d;

  SELECT id INTO v_jan FROM public.fiscal_periods
   WHERE business_id = v_biz_a AND period_type = 'month' AND start_date = DATE '2026-01-01';

  INSERT INTO public.accounts (id, organization_id, business_id, code, name, account_type)
  VALUES (v_exp_a,  v_org_a, v_biz_a, '5000', 'Rent',        'expense'),
         (v_cash_a, v_org_a, v_biz_a, '1000', 'Bank',        'asset'),
         (v_exp_b,  v_org_b, v_biz_b, '5000', 'Rent (B)',    'expense');

  v_je := gen_random_uuid();
  INSERT INTO public.journal_entries (id, organization_id, business_id, entry_number, entry_date, description, status)
  VALUES (v_je, v_org_a, v_biz_a, 'ISO-JE-1', DATE '2026-01-15', 'rent', 'draft');
  INSERT INTO public.journal_entry_lines (journal_entry_id, organization_id, business_id, account_id, debit, credit)
  VALUES (v_je, v_org_a, v_biz_a, v_exp_a, 800, 0), (v_je, v_org_a, v_biz_a, v_cash_a, 0, 800);
  UPDATE public.journal_entries SET status = 'posted' WHERE id = v_je;

  INSERT INTO public.budgets (id, organization_id, business_id, name, fiscal_year, created_by)
  VALUES (v_budget, v_org_a, v_biz_a, 'FY2026 Plan A', 2026, v_user_a);

  INSERT INTO public.budget_items (organization_id, business_id, budget_id, account_id, fiscal_period_id, budgeted_amount)
  VALUES (v_org_a, v_biz_a, v_budget, v_exp_a, v_jan, 1000);

  INSERT INTO public.budget_revisions (id, organization_id, business_id, budget_id, revision_number, reason, created_by)
  VALUES (v_rev, v_org_a, v_biz_a, v_budget, 1, 'fixture', v_user_a);

  -- ===== A: organization B sees none of A's budget rows ====================
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user_b::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT count(*) INTO v_rows FROM public.budgets WHERE id = v_budget;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'LEAK: organization B can read organization A''s budget row';
  END IF;

  SELECT count(*) INTO v_rows FROM public.budget_items WHERE budget_id = v_budget;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'LEAK: organization B can read organization A''s budget lines';
  END IF;

  SELECT count(*) INTO v_rows FROM public.budget_revisions WHERE budget_id = v_budget;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'LEAK: organization B can read organization A''s budget revisions';
  END IF;

  -- ===== B: the variance engine refuses the foreign caller with 42501 ======
  v_blocked := false;
  BEGIN
    PERFORM * FROM public.get_budget_variance_report(v_budget);
  EXCEPTION WHEN insufficient_privilege THEN
    v_blocked := true;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'LEAK: get_budget_variance_report served a foreign organization';
  END IF;

  -- ===== C: the posting-time check refuses the foreign caller ==============
  v_blocked := false;
  BEGIN
    PERFORM * FROM public.check_budget_variance(
      v_org_a, v_biz_a, ARRAY[v_exp_a], ARRAY[100::numeric], DATE '2026-01-20', NULL);
  EXCEPTION WHEN insufficient_privilege THEN
    v_blocked := true;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'LEAK: check_budget_variance served a foreign organization';
  END IF;

  -- ===== D: the period read path refuses the foreign caller ================
  v_blocked := false;
  BEGIN
    PERFORM * FROM public.get_period_budget_variance(v_jan);
  EXCEPTION WHEN insufficient_privilege THEN
    v_blocked := true;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'LEAK: get_period_budget_variance served a foreign organization';
  END IF;

  -- ===== E: the owner is not blocked =======================================
  RESET ROLE;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user_a::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT count(*) INTO v_rows FROM public.budgets WHERE id = v_budget;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'OVER-BLOCK: the owning user cannot read their own budget';
  END IF;

  SELECT count(*) INTO v_rows FROM public.get_budget_variance_report(v_budget);
  IF v_rows < 1 THEN
    RAISE EXCEPTION 'OVER-BLOCK: the owning user gets no variance rows for their own budget';
  END IF;

  RESET ROLE;
  RAISE EXCEPTION 'rollback: budgets isolation fixture passed';
END $$;

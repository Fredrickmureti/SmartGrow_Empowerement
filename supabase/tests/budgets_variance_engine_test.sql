-- Budgets — variance engine and planning-lifecycle fixtures.
--
-- WHAT THIS PROVES
-- `get_budget_variance_report` is the single budget engine. A budget figure is
-- only trustworthy if it is a function of (budget, accounting calendar, posted
-- ledger) and NOTHING else — not the server clock, not a calendar month
-- number, not draft or sample journal activity. This file drives the engine
-- through scenarios A–J on a business whose fiscal year starts in JULY, which
-- is where month-number arithmetic would silently produce the wrong answer.
--
-- It also pins the three planning invariants around the engine:
--   * a period lock governs postings, not plans (draft budgets may be authored
--     into closed periods; active budgets may not);
--   * a budget is always kept in the company base currency;
--   * variance is favourable-positive, decided by account nature in SQL.
--
-- SAFETY
-- The behavioural block seeds its OWN isolated organization and rolls back:
-- the closing `RAISE EXCEPTION 'rollback: ...'` aborts the transaction, so no
-- financial row is ever left behind. `session_replication_role = replica` is
-- used only while seeding ledger scaffolding, and is restored to `origin`
-- before any budget write so the budget triggers under test actually run.

-- ---------------------------------------------------------------------------
-- 1) Contract: exactly one engine, defined once.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_count int; v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['get_budget_variance_report','budget_fiscal_months',
                                'apply_budget_revision','_budget_items_normalize'] LOOP
    SELECT count(*) INTO v_count
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_count <> 1 THEN
      RAISE EXCEPTION '% has % definitions — there must be exactly one', v_name, v_count;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2) Contract: the engine is hardened and reads the plan on the period key.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  SELECT p.oid, p.prosecdef, p.proconfig, p.prosrc INTO r
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_budget_variance_report';

  IF NOT r.prosecdef THEN
    RAISE EXCEPTION 'get_budget_variance_report is not SECURITY DEFINER';
  END IF;
  IF NOT (COALESCE(array_to_string(r.proconfig, ','), '') ~ 'search_path=') THEN
    RAISE EXCEPTION 'get_budget_variance_report has no pinned search_path';
  END IF;
  IF r.prosrc !~ '_budget_assert_read' THEN
    RAISE EXCEPTION 'get_budget_variance_report does not assert read permission';
  END IF;
  IF r.prosrc !~ 'bi\.fiscal_period_id' THEN
    RAISE EXCEPTION 'the plan is not joined to the ledger on fiscal_period_id';
  END IF;
  IF r.prosrc !~ 'ledger_visible_journal_statuses' THEN
    RAISE EXCEPTION 'actuals are not restricted to ledger-visible journal statuses';
  END IF;
  IF has_function_privilege('anon', r.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'get_budget_variance_report is executable by anon — budgets would be public';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3) Behavioural: scenarios A–J on a JULY fiscal year.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_biz uuid := gen_random_uuid();
  v_biz2 uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
  v_exp uuid := gen_random_uuid();      -- 5000 budgeted expense
  v_exp2 uuid := gen_random_uuid();     -- 5100 unbudgeted expense
  v_inc uuid := gen_random_uuid();      -- 4000 budgeted income
  v_cash uuid := gen_random_uuid();     -- 1000 contra side
  v_exp_b2 uuid := gen_random_uuid();   -- other company's expense account
  v_budget uuid := gen_random_uuid();
  v_july uuid;
  v_aug uuid;
  v_sep uuid;
  v_je uuid;
  v_rows int;
  v_actual numeric;
  v_budgeted numeric;
  v_variance numeric;
  v_fav boolean;
  v_ordinal int;
  v_month int;
  v_currency text;
  v_failed boolean;
BEGIN
  PERFORM set_config('session_replication_role', 'replica', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);

  INSERT INTO auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  VALUES (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'budget-fixture-' || replace(v_user::text, '-', '') || '@example.test', now(), now());

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Budget Fixture', 'budget-fixture-' || replace(v_org::text, '-', ''));

  INSERT INTO public.user_roles (user_id, organization_id, role, is_active)
  VALUES (v_user, v_org, 'owner', true);

  -- A JULY fiscal year: month numbers and fiscal ordinals disagree all year.
  INSERT INTO public.businesses (id, organization_id, name, country, base_currency, fiscal_year_start)
  VALUES (v_biz, v_org, 'July Co', 'KE', 'KES', 7),
         (v_biz2, v_org, 'Sister Co', 'KE', 'KES', 7);

  INSERT INTO public.fiscal_periods (organization_id, business_id, name, period_type, start_date, end_date, status)
  VALUES (v_org, v_biz, 'FY2026', 'year', DATE '2026-07-01', DATE '2027-06-30', 'open');

  INSERT INTO public.fiscal_periods (organization_id, business_id, name, period_type, start_date, end_date, status)
  SELECT v_org, v_biz,
         to_char(d, 'Mon YYYY'), 'month', d::date, (d + INTERVAL '1 month' - INTERVAL '1 day')::date,
         -- September 2026 is CLOSED: planning into it must still be allowed
         -- for a draft budget.
         CASE WHEN d = DATE '2026-09-01' THEN 'closed' ELSE 'open' END
    FROM generate_series(DATE '2026-07-01', DATE '2027-06-01', INTERVAL '1 month') d;

  SELECT id INTO v_july FROM public.fiscal_periods
   WHERE business_id = v_biz AND period_type = 'month' AND start_date = DATE '2026-07-01';
  SELECT id INTO v_aug FROM public.fiscal_periods
   WHERE business_id = v_biz AND period_type = 'month' AND start_date = DATE '2026-08-01';
  SELECT id INTO v_sep FROM public.fiscal_periods
   WHERE business_id = v_biz AND period_type = 'month' AND start_date = DATE '2026-09-01';

  INSERT INTO public.accounts (id, organization_id, business_id, code, name, account_type)
  VALUES (v_exp,    v_org, v_biz,  '5000', 'Rent',            'expense'),
         (v_exp2,   v_org, v_biz,  '5100', 'Bank charges',    'expense'),
         (v_inc,    v_org, v_biz,  '4000', 'Consulting',      'income'),
         (v_cash,   v_org, v_biz,  '1000', 'Bank',            'asset'),
         (v_exp_b2, v_org, v_biz2, '5000', 'Rent (sister)',   'expense');

  -- ===== Ledger fixtures ===================================================
  -- Posted: rent 800 in July, consulting income 4000 in August,
  -- unbudgeted bank charges 300 in July.
  v_je := gen_random_uuid();
  INSERT INTO public.journal_entries (id, organization_id, business_id, entry_number, entry_date, description, status)
  VALUES (v_je, v_org, v_biz, 'JE-1', DATE '2026-07-15', 'rent', 'posted');
  INSERT INTO public.journal_entry_lines (journal_entry_id, organization_id, business_id, account_id, debit, credit)
  VALUES (v_je, v_org, v_biz, v_exp, 800, 0), (v_je, v_org, v_biz, v_cash, 0, 800);

  v_je := gen_random_uuid();
  INSERT INTO public.journal_entries (id, organization_id, business_id, entry_number, entry_date, description, status)
  VALUES (v_je, v_org, v_biz, 'JE-2', DATE '2026-08-10', 'fees', 'posted');
  INSERT INTO public.journal_entry_lines (journal_entry_id, organization_id, business_id, account_id, debit, credit)
  VALUES (v_je, v_org, v_biz, v_inc, 0, 4000), (v_je, v_org, v_biz, v_cash, 4000, 0);

  v_je := gen_random_uuid();
  INSERT INTO public.journal_entries (id, organization_id, business_id, entry_number, entry_date, description, status)
  VALUES (v_je, v_org, v_biz, 'JE-3', DATE '2026-07-20', 'bank charges', 'posted');
  INSERT INTO public.journal_entry_lines (journal_entry_id, organization_id, business_id, account_id, debit, credit)
  VALUES (v_je, v_org, v_biz, v_exp2, 300, 0), (v_je, v_org, v_biz, v_cash, 0, 300);

  -- Draft entry: an unposted document is not accounting activity.
  v_je := gen_random_uuid();
  INSERT INTO public.journal_entries (id, organization_id, business_id, entry_number, entry_date, description, status)
  VALUES (v_je, v_org, v_biz, 'JE-4', DATE '2026-07-25', 'draft rent', 'draft');
  INSERT INTO public.journal_entry_lines (journal_entry_id, organization_id, business_id, account_id, debit, credit)
  VALUES (v_je, v_org, v_biz, v_exp, 5000, 0), (v_je, v_org, v_biz, v_cash, 0, 5000);

  -- Demo data: never a real number.
  v_je := gen_random_uuid();
  INSERT INTO public.journal_entries (id, organization_id, business_id, entry_number, entry_date, description, status, is_sample_data)
  VALUES (v_je, v_org, v_biz, 'JE-5', DATE '2026-07-26', 'sample rent', 'posted', true);
  INSERT INTO public.journal_entry_lines (journal_entry_id, organization_id, business_id, account_id, debit, credit, is_sample_data)
  VALUES (v_je, v_org, v_biz, v_exp, 7000, 0, true), (v_je, v_org, v_biz, v_cash, 0, 7000, true);

  -- The sister company books rent in the same month. It must never appear.
  v_je := gen_random_uuid();
  INSERT INTO public.journal_entries (id, organization_id, business_id, entry_number, entry_date, description, status)
  VALUES (v_je, v_org, v_biz2, 'JE-B2', DATE '2026-07-15', 'sister rent', 'posted');
  INSERT INTO public.journal_entry_lines (journal_entry_id, organization_id, business_id, account_id, debit, credit)
  VALUES (v_je, v_org, v_biz2, v_exp_b2, 9999, 0);

  -- ===== Budget fixtures ===================================================
  -- Budget triggers are the subject from here on, so restore normal firing.
  PERFORM set_config('session_replication_role', 'origin', true);

  INSERT INTO public.budgets (id, organization_id, business_id, name, fiscal_year, created_by)
  VALUES (v_budget, v_org, v_biz, 'FY2026 Plan', 2026, v_user);

  -- ===== H: a budget is kept in the company base currency ==================
  SELECT currency_code INTO v_currency FROM public.budgets WHERE id = v_budget;
  IF v_currency IS DISTINCT FROM 'KES' THEN
    RAISE EXCEPTION 'H: budget currency should be derived as KES, got %', v_currency;
  END IF;

  v_failed := false;
  BEGIN
    INSERT INTO public.budgets (organization_id, business_id, name, fiscal_year, currency_code, created_by)
    VALUES (v_org, v_biz, 'Foreign plan', 2026, 'EUR', v_user);
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'H: a budget in a non-base currency was accepted';
  END IF;

  -- period_month is the CALENDAR month; July = 7, August = 8.
  INSERT INTO public.budget_items (budget_id, account_id, period_month, budgeted_amount)
  VALUES (v_budget, v_exp, 7, 1000),
         (v_budget, v_inc, 8, 5000);

  -- ===== I: a period lock governs postings, not plans ======================
  -- September 2026 is closed; a DRAFT budget may still be planned into it.
  INSERT INTO public.budget_items (budget_id, account_id, period_month, budgeted_amount)
  VALUES (v_budget, v_exp, 9, 1200);

  IF NOT EXISTS (
    SELECT 1 FROM public.budget_items
     WHERE budget_id = v_budget AND account_id = v_exp AND fiscal_period_id = v_sep
  ) THEN
    RAISE EXCEPTION 'I: a draft budget could not be planned into a closed period';
  END IF;

  -- ===== F: the plan is keyed on the accounting period, not the month ======
  IF NOT EXISTS (
    SELECT 1 FROM public.budget_items
     WHERE budget_id = v_budget AND account_id = v_exp AND fiscal_period_id = v_july
  ) THEN
    RAISE EXCEPTION 'F: the July plan line did not resolve to the July fiscal period';
  END IF;

  -- ===== A: expense underspend is FAVOURABLE (positive) ====================
  SELECT budgeted_amount, actual_amount, variance_amount, is_favourable, period_ordinal, period_month
    INTO v_budgeted, v_actual, v_variance, v_fav, v_ordinal, v_month
    FROM public.get_budget_variance_report(v_budget)
   WHERE account_id = v_exp AND fiscal_period_id = v_july;

  IF v_budgeted <> 1000 OR v_actual <> 800 THEN
    RAISE EXCEPTION 'A: expected plan 1000 / actual 800, got % / %', v_budgeted, v_actual;
  END IF;
  IF v_variance <> 200 OR NOT v_fav THEN
    RAISE EXCEPTION 'A: expected +200 favourable, got % (favourable=%)', v_variance, v_fav;
  END IF;

  -- ===== C + D: draft and sample activity are not actuals ==================
  -- Already proven by A: the draft 5000 and sample 7000 would have moved it.

  -- ===== F(2): July is fiscal ordinal 1 in a July year =====================
  IF v_ordinal <> 1 OR v_month <> 7 THEN
    RAISE EXCEPTION 'F: July should be ordinal 1 / month 7, got ordinal % / month %', v_ordinal, v_month;
  END IF;

  -- ===== B: income shortfall is UNFAVOURABLE (negative) ====================
  SELECT budgeted_amount, actual_amount, variance_amount, is_favourable, period_ordinal
    INTO v_budgeted, v_actual, v_variance, v_fav, v_ordinal
    FROM public.get_budget_variance_report(v_budget)
   WHERE account_id = v_inc AND fiscal_period_id = v_aug;

  IF v_budgeted <> 5000 OR v_actual <> 4000 THEN
    RAISE EXCEPTION 'B: expected plan 5000 / actual 4000, got % / %', v_budgeted, v_actual;
  END IF;
  IF v_variance <> -1000 OR v_fav THEN
    RAISE EXCEPTION 'B: expected -1000 unfavourable, got % (favourable=%)', v_variance, v_fav;
  END IF;
  IF v_ordinal <> 2 THEN
    RAISE EXCEPTION 'B: August should be fiscal ordinal 2, got %', v_ordinal;
  END IF;

  -- ===== E: unbudgeted operating spend is surfaced, not hidden =============
  SELECT budgeted_amount, actual_amount, variance_amount
    INTO v_budgeted, v_actual, v_variance
    FROM public.get_budget_variance_report(v_budget)
   WHERE account_id = v_exp2 AND fiscal_period_id = v_july AND is_unbudgeted;

  IF v_budgeted <> 0 OR v_actual <> 300 OR v_variance <> -300 THEN
    RAISE EXCEPTION 'E: expected unbudgeted 0/300/-300, got %/%/%', v_budgeted, v_actual, v_variance;
  END IF;

  -- ===== G: the sister company's ledger is invisible =======================
  SELECT count(*) INTO v_rows
    FROM public.get_budget_variance_report(v_budget) r
    JOIN public.accounts a ON a.id = r.account_id
   WHERE a.business_id <> v_biz;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'G: % row(s) from another company leaked into the report', v_rows;
  END IF;

  -- ===== J: the balance sheet is not reported as overspend =================
  SELECT count(*) INTO v_rows
    FROM public.get_budget_variance_report(v_budget)
   WHERE account_id = v_cash;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'J: unbudgeted balance-sheet movement was reported as budget activity';
  END IF;

  -- ===== I(2): once in force, lines are frozen against direct edits ========
  UPDATE public.budgets SET status = 'active' WHERE id = v_budget;

  v_failed := false;
  BEGIN
    UPDATE public.budget_items SET budgeted_amount = 4242
     WHERE budget_id = v_budget AND account_id = v_exp AND fiscal_period_id = v_july;
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'I: an active budget accepted a direct line edit outside a revision';
  END IF;

  -- ===== K: a revision identified by fiscal period rewrites that period ====
  PERFORM public.apply_budget_revision(
    v_budget, 'Landlord increase', json_build_array(
      json_build_object('account_id', v_exp, 'fiscal_period_id', v_july, 'budgeted_amount', 1500)
    )::jsonb, NULL);

  SELECT budgeted_amount INTO v_budgeted
    FROM public.budget_items
   WHERE budget_id = v_budget AND account_id = v_exp AND fiscal_period_id = v_july;
  IF v_budgeted <> 1500 THEN
    RAISE EXCEPTION 'K: the revision did not reach the July plan line (now %)', v_budgeted;
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.budget_items
   WHERE budget_id = v_budget AND account_id = v_exp AND fiscal_period_id = v_july;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'K: the revision duplicated the July plan line (% rows)', v_rows;
  END IF;

  SELECT previous_amount INTO v_budgeted
    FROM public.budget_revision_lines l
    JOIN public.budget_revisions r ON r.id = l.revision_id
   WHERE r.budget_id = v_budget AND l.fiscal_period_id = v_july;
  IF v_budgeted <> 1000 THEN
    RAISE EXCEPTION 'K: the revision trail lost the previous amount (got %)', v_budgeted;
  END IF;

  RAISE EXCEPTION 'rollback: budgets variance engine fixtures passed';
END $$;

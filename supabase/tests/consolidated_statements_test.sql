-- Consolidated statements (Brick 5) — invariants.
--   psql "$DATABASE_URL" -f supabase/tests/consolidated_statements_test.sql
--
-- The consolidated P&L and balance sheet must be a *projection* of the
-- translated consolidated trial balance and nothing else: same engine, same
-- rates, same refusals. This suite proves the projection is faithful — the
-- balance sheet balances, the result carried on it is the result reported by
-- the P&L, no account lands on the wrong statement, the translation reserve
-- survives as its own equity line, and a period the trial balance refuses is
-- refused here too. The whole fixture rolls itself back.

-- Contract checks: no second engine, caller's own permissions, signed-in only.
DO $$
DECLARE
  v_src text;
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['get_consolidated_statement_lines', 'get_consolidated_statement_totals'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = v_fn) THEN
      RAISE EXCEPTION '% is missing', v_fn;
    END IF;
    IF (SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = v_fn) THEN
      RAISE EXCEPTION '% must run with the caller''s own permissions, not the definer''s', v_fn;
    END IF;
    IF NOT has_function_privilege('authenticated', format('public.%I(uuid, date, date)', v_fn), 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated must be able to execute %', v_fn;
    END IF;
    IF has_function_privilege('anon', format('public.%I(uuid, date, date)', v_fn), 'EXECUTE') THEN
      RAISE EXCEPTION 'anon must not execute %', v_fn;
    END IF;
  END LOOP;

  -- The lines function may read the consolidation engine and nothing lower.
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_consolidated_statement_lines';
  IF v_src NOT LIKE '%get_consolidated_trial_balance_translated%' THEN
    RAISE EXCEPTION 'the statements do not read the translated consolidated trial balance';
  END IF;
  IF v_src LIKE '%journal_entry_lines%' OR v_src LIKE '%fx_rate_on%' THEN
    RAISE EXCEPTION 'the statements reach past the consolidation engine into the ledger or the rate table';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_consolidated_statement_totals';
  IF v_src NOT LIKE '%get_consolidated_statement_lines%' THEN
    RAISE EXCEPTION 'the totals are not derived from the statement lines';
  END IF;

  RAISE NOTICE 'consolidated statements: contract checks passed';
END $$;

-- Behavioural fixture: a KES group with a USD subsidiary that traded in March.
DO $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
  v_p uuid := gen_random_uuid();
  v_s uuid := gen_random_uuid();
  v_group uuid := gen_random_uuid();
  v_cta uuid; v_cash_p uuid; v_stock_p uuid;
  v_cash_s uuid; v_stock_s uuid; v_rev_s uuid; v_exp_s uuid;
  v_je uuid;
  v_hist date := DATE '2026-02-10';
  v_tot record; v_line record; v_rate_avg numeric; v_reserve numeric;
  v_refused boolean;
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  VALUES (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'consol-stmt-' || replace(v_user::text,'-','') || '@example.test', now(), now());
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Consolidation Statements Org', 'consol-stmt-' || replace(v_org::text,'-',''));
  INSERT INTO public.user_roles (user_id, organization_id, role, is_active) VALUES (v_user, v_org, 'owner', true);
  INSERT INTO public.businesses (id, organization_id, name, country, base_currency, fiscal_year_start)
  VALUES (v_p, v_org, 'Stmt Parent Ltd', 'KE', 'KES', 1), (v_s, v_org, 'Stmt Sub Inc', 'US', 'USD', 1);

  -- A moving rate, so translating at the wrong rate cannot pass unnoticed.
  INSERT INTO public.exchange_rates (organization_id, business_id, from_currency, to_currency, rate, effective_date, source, published_at)
  SELECT v_org, v_p, 'USD', 'KES', 100 + (d::date - DATE '2026-01-01') * 0.10, d::date, 'manual', now()
    FROM generate_series(DATE '2026-01-01', DATE '2026-03-31', INTERVAL '1 day') d;

  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_p, 'asset', 'cash_on_hand', '1000', 'Cash P') RETURNING id INTO v_cash_p;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_p, 'equity', 'common_stock', '3000', 'Share capital P') RETURNING id INTO v_stock_p;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_p, 'equity', 'accumulated_other_comprehensive_income', '3900', 'Foreign currency translation reserve') RETURNING id INTO v_cta;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_s, 'asset', 'cash_on_hand', '1000', 'Cash S') RETURNING id INTO v_cash_s;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_s, 'equity', 'common_stock', '3000', 'Share capital S') RETURNING id INTO v_stock_s;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_s, 'income', 'sales_income', '4000', 'Revenue S') RETURNING id INTO v_rev_s;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_s, 'expense', 'other_expense', '5000', 'Costs S') RETURNING id INTO v_exp_s;

  INSERT INTO public.journal_entries (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_p, 'ST-P-1', v_hist, 'Share issue', 'draft', 'KES', 1) RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines (organization_id, business_id, journal_entry_id, account_id, debit, credit)
  VALUES (v_org, v_p, v_je, v_cash_p, 300000, 0), (v_org, v_p, v_je, v_stock_p, 0, 300000);
  UPDATE public.journal_entries SET status='posted', posted_at=now() WHERE id = v_je;

  INSERT INTO public.journal_entries (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_s, 'ST-S-1', v_hist, 'Share issue', 'draft', 'USD', 1) RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines (organization_id, business_id, journal_entry_id, account_id, debit, credit)
  VALUES (v_org, v_s, v_je, v_cash_s, 1000, 0), (v_org, v_s, v_je, v_stock_s, 0, 1000);
  UPDATE public.journal_entries SET status='posted', posted_at=now() WHERE id = v_je;

  INSERT INTO public.journal_entries (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_s, 'ST-S-2', DATE '2026-03-20', 'Trading', 'draft', 'USD', 1) RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines (organization_id, business_id, journal_entry_id, account_id, debit, credit)
  VALUES (v_org, v_s, v_je, v_cash_s, 500, 0), (v_org, v_s, v_je, v_rev_s, 0, 500),
         (v_org, v_s, v_je, v_exp_s, 200, 0), (v_org, v_s, v_je, v_cash_s, 0, 200);
  UPDATE public.journal_entries SET status='posted', posted_at=now() WHERE id = v_je;

  INSERT INTO public.consolidation_groups (id, organization_id, name, parent_business_id, presentation_currency, cta_account_id)
  VALUES (v_group, v_org, 'Stmt Group', v_p, 'KES', v_cta);
  INSERT INTO public.consolidation_group_members (organization_id, group_id, business_id, ownership_percent, method, effective_from)
  VALUES (v_org, v_group, v_p, 100, 'full', DATE '2026-01-01');
  INSERT INTO public.consolidation_group_members (organization_id, group_id, business_id, parent_business_id, ownership_percent, method, effective_from, historical_rate_date)
  VALUES (v_org, v_group, v_s, v_p, 100, 'full', DATE '2026-01-01', v_hist);

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);

  SELECT r.average_rate INTO v_rate_avg
    FROM public.consolidation_member_translation_rates(v_group, v_s, DATE '2026-03-01', DATE '2026-03-31') r;

  SELECT * INTO v_tot FROM public.get_consolidated_statement_totals(v_group, DATE '2026-03-01', DATE '2026-03-31');
  IF v_tot IS NULL THEN RAISE EXCEPTION 'the consolidated statements returned nothing'; END IF;
  IF v_tot.presentation_currency <> 'KES' THEN
    RAISE EXCEPTION 'statements reported in % rather than the group presentation currency', v_tot.presentation_currency;
  END IF;
  IF NOT v_tot.is_balanced THEN
    RAISE EXCEPTION 'the consolidated balance sheet does not balance: assets % vs liabilities % plus equity % (difference %)',
      v_tot.total_assets, v_tot.total_liabilities, v_tot.total_equity, v_tot.balance_difference;
  END IF;
  IF round(v_tot.total_income, 2) <> round(500 * v_rate_avg, 2) THEN
    RAISE EXCEPTION 'consolidated income % but revenue at the average rate is %', v_tot.total_income, round(500 * v_rate_avg, 2);
  END IF;
  IF round(v_tot.total_expense, 2) <> round(200 * v_rate_avg, 2) THEN
    RAISE EXCEPTION 'consolidated expenses % but costs at the average rate is %', v_tot.total_expense, round(200 * v_rate_avg, 2);
  END IF;
  IF round(v_tot.net_result, 2) <> round(v_tot.total_income - v_tot.total_expense, 2) THEN
    RAISE EXCEPTION 'the result is not income less expenses';
  END IF;
  IF v_tot.translation_reserve = 0 THEN
    RAISE EXCEPTION 'a foreign subsidiary produced no translation reserve';
  END IF;

  SELECT * INTO v_line FROM public.get_consolidated_statement_lines(v_group, DATE '2026-03-01', DATE '2026-03-31') l
   WHERE l.statement = 'balance_sheet' AND l.is_derived;
  IF v_line IS NULL THEN RAISE EXCEPTION 'the balance sheet has no line for the result of the period'; END IF;
  IF round(v_line.amount, 2) <> round(v_tot.net_result, 2) THEN
    RAISE EXCEPTION 'the balance sheet carries % as the period result but the income statement reports %',
      v_line.amount, v_tot.net_result;
  END IF;

  PERFORM 1 FROM public.get_consolidated_statement_lines(v_group, DATE '2026-03-01', DATE '2026-03-31') l
    WHERE (l.statement = 'balance_sheet' AND NOT l.is_derived AND l.account_type IN ('income','expense'))
       OR (l.statement = 'income_statement' AND l.account_type NOT IN ('income','expense'));
  IF FOUND THEN RAISE EXCEPTION 'an account appeared on the wrong statement'; END IF;

  SELECT sum(l.amount) INTO v_reserve
    FROM public.get_consolidated_statement_lines(v_group, DATE '2026-03-01', DATE '2026-03-31') l
   WHERE l.is_residual;
  IF round(COALESCE(v_reserve, 0), 2) <> round(v_tot.translation_reserve, 2) THEN
    RAISE EXCEPTION 'the translation reserve line and total disagree';
  END IF;

  -- January has no rate coverage back to the fiscal year start for the
  -- subsidiary's opening: the trial balance refuses, so must the statements.
  v_refused := false;
  BEGIN
    PERFORM * FROM public.get_consolidated_statement_totals(v_group, DATE '2026-01-01', DATE '2026-01-31');
  EXCEPTION WHEN others THEN v_refused := true; END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'the statements reported figures over a period the trial balance refuses';
  END IF;

  RAISE EXCEPTION 'rollback: consolidated statements passed (assets %, liabilities %, equity %, result %)',
    v_tot.total_assets, v_tot.total_liabilities, v_tot.total_equity, v_tot.net_result;
END $$;

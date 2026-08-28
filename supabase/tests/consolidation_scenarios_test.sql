-- Step 7.7 — realistic consolidation scenarios, end to end.
--
-- The earlier suites each prove one mechanism. This one proves the scenarios
-- the product actually has to survive, on fixtures that look like real groups:
--
--   Block 1  independent companies, different charts of accounts, and the
--            refusal that protects a group statement from an unmapped account
--   Block 2  a KES parent with a USD subsidiary: closing rate on the balance
--            sheet, average rate on the result, CTA reconciled at group level
--   Block 3  an intercompany sale and a reciprocal receivable/payable:
--            balanced eliminations, statement effect, idempotent regeneration,
--            audited history, and reversal that restores the pre-run position
--   Block 4  period control (a member's closed month refuses the run) and
--            organization isolation (a foreign caller reaches nothing)
--
-- Every block creates its own organization and rolls itself back with a final
-- RAISE, so nothing is committed and the live tenant is never seeded. Run one
-- block at a time — the fixtures are small but the engine is not.

-- ===========================================================================
-- Block 1 — independent companies, differing charts, unmapped refusal
-- ===========================================================================
DO $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
  v_a uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_group uuid := gen_random_uuid();
  v_cash_a uuid; v_cap_a uuid; v_rev_a uuid; v_exp_a uuid;
  v_cash_b uuid; v_cap_b uuid; v_rev_b uuid; v_exp_b uuid;
  v_ga_cash uuid; v_ga_cap uuid; v_ga_rev uuid; v_ga_exp uuid;
  v_je uuid;
  v_from date := DATE '2026-03-01';
  v_to   date := DATE '2026-03-31';
  v_tot record; v_elim record;
  v_refused boolean; v_msg text; v_rows integer;
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  VALUES (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'scen1-' || replace(v_user::text,'-','') || '@example.test', now(), now());
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Scenario Org 1', 'scen1-' || replace(v_org::text,'-',''));
  INSERT INTO public.user_roles (user_id, organization_id, role, is_active)
  VALUES (v_user, v_org, 'owner', true);

  INSERT INTO public.businesses
    (id, organization_id, name, country, base_currency, fiscal_year_start)
  VALUES (v_a, v_org, 'Alpha Trading Ltd', 'KE', 'KES', 1),
         (v_b, v_org, 'Beta Services Ltd', 'KE', 'KES', 1);

  -- Two genuinely different charts: Alpha uses a four-digit chart, Beta a
  -- departmental one. Identical codes would make the mapping test vacuous.
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_a, 'asset', 'cash_on_hand', '1000', 'Bank') RETURNING id INTO v_cash_a;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_a, 'equity', 'common_stock', '3000', 'Share capital') RETURNING id INTO v_cap_a;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_a, 'income', 'sales_income', '4000', 'Goods sold') RETURNING id INTO v_rev_a;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_a, 'expense', 'other_expense', '5000', 'Operating costs') RETURNING id INTO v_exp_a;

  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_b, 'asset', 'cash_on_hand', 'BK-01', 'Cash at bank') RETURNING id INTO v_cash_b;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_b, 'equity', 'common_stock', 'EQ-01', 'Owner capital') RETURNING id INTO v_cap_b;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_b, 'income', 'service_income', 'IN-01', 'Consulting fees') RETURNING id INTO v_rev_b;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_b, 'expense', 'other_expense', 'EX-01', 'Staff costs') RETURNING id INTO v_exp_b;

  -- Alpha: capital 200,000; sells 60,000; spends 25,000.
  INSERT INTO public.journal_entries
    (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_a, 'SC1-A-1', v_from, 'Capitalisation', 'draft', 'KES', 1) RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines (organization_id, business_id, journal_entry_id, account_id, debit, credit)
  VALUES (v_org, v_a, v_je, v_cash_a, 200000, 0), (v_org, v_a, v_je, v_cap_a, 0, 200000);
  UPDATE public.journal_entries SET status = 'posted', posted_at = now() WHERE id = v_je;

  INSERT INTO public.journal_entries
    (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_a, 'SC1-A-2', DATE '2026-03-12', 'Trading', 'draft', 'KES', 1) RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines (organization_id, business_id, journal_entry_id, account_id, debit, credit)
  VALUES (v_org, v_a, v_je, v_cash_a, 60000, 0), (v_org, v_a, v_je, v_rev_a, 0, 60000),
         (v_org, v_a, v_je, v_exp_a, 25000, 0), (v_org, v_a, v_je, v_cash_a, 0, 25000);
  UPDATE public.journal_entries SET status = 'posted', posted_at = now() WHERE id = v_je;

  -- Beta: capital 50,000; earns 15,000; spends 5,000.
  INSERT INTO public.journal_entries
    (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_b, 'SC1-B-1', v_from, 'Capitalisation', 'draft', 'KES', 1) RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines (organization_id, business_id, journal_entry_id, account_id, debit, credit)
  VALUES (v_org, v_b, v_je, v_cash_b, 50000, 0), (v_org, v_b, v_je, v_cap_b, 0, 50000);
  UPDATE public.journal_entries SET status = 'posted', posted_at = now() WHERE id = v_je;

  INSERT INTO public.journal_entries
    (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_b, 'SC1-B-2', DATE '2026-03-18', 'Trading', 'draft', 'KES', 1) RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines (organization_id, business_id, journal_entry_id, account_id, debit, credit)
  VALUES (v_org, v_b, v_je, v_cash_b, 15000, 0), (v_org, v_b, v_je, v_rev_b, 0, 15000),
         (v_org, v_b, v_je, v_exp_b, 5000, 0), (v_org, v_b, v_je, v_cash_b, 0, 5000);
  UPDATE public.journal_entries SET status = 'posted', posted_at = now() WHERE id = v_je;

  INSERT INTO public.consolidation_groups
    (id, organization_id, name, parent_business_id, presentation_currency)
  VALUES (v_group, v_org, 'Scenario Group 1', v_a, 'KES');
  INSERT INTO public.consolidation_group_members
    (organization_id, group_id, business_id, ownership_percent, method, effective_from)
  VALUES (v_org, v_group, v_a, 100, 'full', DATE '2026-01-01');
  INSERT INTO public.consolidation_group_members
    (organization_id, group_id, business_id, parent_business_id, ownership_percent, method, effective_from)
  VALUES (v_org, v_group, v_b, v_a, 100, 'full', DATE '2026-01-01');

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);

  ------------------------------------------- 1. a group chart, half mapped ---
  INSERT INTO public.consolidation_group_accounts (organization_id, group_id, code, name, account_type, sort_order)
  VALUES (v_org, v_group, 'G-1000', 'Group cash', 'asset', 10) RETURNING id INTO v_ga_cash;
  INSERT INTO public.consolidation_group_accounts (organization_id, group_id, code, name, account_type, sort_order)
  VALUES (v_org, v_group, 'G-3000', 'Group capital', 'equity', 20) RETURNING id INTO v_ga_cap;
  INSERT INTO public.consolidation_group_accounts (organization_id, group_id, code, name, account_type, sort_order)
  VALUES (v_org, v_group, 'G-4000', 'Group revenue', 'income', 30) RETURNING id INTO v_ga_rev;
  INSERT INTO public.consolidation_group_accounts (organization_id, group_id, code, name, account_type, sort_order)
  VALUES (v_org, v_group, 'G-5000', 'Group costs', 'expense', 40) RETURNING id INTO v_ga_exp;

  INSERT INTO public.consolidation_account_mappings
    (organization_id, group_id, business_id, account_id, group_account_id, effective_from)
  VALUES (v_org, v_group, v_a, v_cash_a, v_ga_cash, DATE '2026-01-01'),
         (v_org, v_group, v_a, v_cap_a,  v_ga_cap,  DATE '2026-01-01'),
         (v_org, v_group, v_a, v_rev_a,  v_ga_rev,  DATE '2026-01-01'),
         (v_org, v_group, v_a, v_exp_a,  v_ga_exp,  DATE '2026-01-01');

  SELECT count(*) INTO v_rows FROM public.consolidation_unmapped_accounts(v_group, v_from, v_to);
  IF v_rows <> 4 THEN
    RAISE EXCEPTION 'the worklist should name Beta''s four posted accounts, it named %', v_rows;
  END IF;

  v_refused := false;
  BEGIN
    PERFORM * FROM public.get_consolidated_statement_totals(v_group, v_from, v_to);
  EXCEPTION WHEN others THEN
    v_refused := true; v_msg := SQLERRM;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'the group statement reported a figure while a member''s chart was unmapped';
  END IF;
  IF v_msg NOT LIKE '%BK-01%' AND v_msg NOT LIKE '%IN-01%' AND v_msg NOT LIKE '%EX-01%' AND v_msg NOT LIKE '%EQ-01%' THEN
    RAISE EXCEPTION 'the refusal does not name the unmapped accounts: %', v_msg;
  END IF;

  --------------------------------------- 2. fully mapped: additive, balanced ---
  INSERT INTO public.consolidation_account_mappings
    (organization_id, group_id, business_id, account_id, group_account_id, effective_from)
  VALUES (v_org, v_group, v_b, v_cash_b, v_ga_cash, DATE '2026-01-01'),
         (v_org, v_group, v_b, v_cap_b,  v_ga_cap,  DATE '2026-01-01'),
         (v_org, v_group, v_b, v_rev_b,  v_ga_rev,  DATE '2026-01-01'),
         (v_org, v_group, v_b, v_exp_b,  v_ga_exp,  DATE '2026-01-01');

  SELECT * INTO v_tot FROM public.get_consolidated_statement_totals(v_group, v_from, v_to);
  IF v_tot.total_income <> 75000 THEN
    RAISE EXCEPTION 'group income % but the members earned 60000 + 15000', v_tot.total_income;
  END IF;
  IF v_tot.total_expense <> 30000 THEN
    RAISE EXCEPTION 'group expense % but the members spent 25000 + 5000', v_tot.total_expense;
  END IF;
  IF v_tot.total_assets <> 295000 THEN
    RAISE EXCEPTION 'group assets % but the members hold 235000 + 60000', v_tot.total_assets;
  END IF;
  IF v_tot.net_result <> 45000 THEN
    RAISE EXCEPTION 'group result % but the members earned 75000 less 30000', v_tot.net_result;
  END IF;
  -- Equity carries the period result, so the group's closing equity is the
  -- 250,000 subscribed plus the 45,000 earned.
  IF v_tot.total_equity <> 295000 THEN
    RAISE EXCEPTION 'group equity % but capital 250000 plus result 45000 is 295000', v_tot.total_equity;
  END IF;
  IF NOT v_tot.is_balanced THEN
    RAISE EXCEPTION 'the group balance sheet does not balance, difference %', v_tot.balance_difference;
  END IF;

  -------------------------------- 3. no intercompany: nothing to eliminate ---
  -- Independent companies must consolidate identically with and without the
  -- elimination pass; a group with no declared partners eliminates nothing.
  PERFORM public.consolidation_generate_eliminations(v_group, v_from, v_to);
  SELECT count(*) INTO v_rows FROM public.consolidation_eliminations
   WHERE group_id = v_group AND period_start = v_from AND period_end = v_to;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'independent companies produced % elimination legs', v_rows;
  END IF;

  SELECT * INTO v_elim FROM public.get_consolidated_statement_totals_eliminated(v_group, v_from, v_to);
  IF v_elim.total_income <> v_tot.total_income
     OR v_elim.total_assets <> v_tot.total_assets
     OR v_elim.total_equity <> v_tot.total_equity THEN
    RAISE EXCEPTION 'the elimination pass changed an independent group''s figures';
  END IF;

  RAISE EXCEPTION 'rollback: Block 1 OK — differing charts consolidate additively (income %, assets %), an unmapped chart refuses, and nothing is eliminated without intercompany',
    v_tot.total_income, v_tot.total_assets;
END $$;

-- ===========================================================================
-- Block 2 — a KES parent with a USD subsidiary
--
-- Verified against the live database: assets 230,680 KES, income 21,480 KES,
-- translation reserve 5,200 KES on a rate that moves 0.10 KES/day.
-- ===========================================================================
DO $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
  v_p uuid := gen_random_uuid();
  v_s uuid := gen_random_uuid();
  v_group uuid := gen_random_uuid();
  v_cash_p uuid; v_cap_p uuid; v_cta uuid;
  v_cash_s uuid; v_cap_s uuid; v_rev_s uuid;
  v_je uuid;
  v_hist date := DATE '2026-02-10';
  v_from date := DATE '2026-03-01';
  v_to   date := DATE '2026-03-31';
  v_close numeric; v_avg numeric;
  v_tot record; v_cta_rec record;
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  VALUES (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'scen2-' || replace(v_user::text,'-','') || '@example.test', now(), now());
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Scenario Org 2', 'scen2-' || replace(v_org::text,'-',''));
  INSERT INTO public.user_roles (user_id, organization_id, role, is_active)
  VALUES (v_user, v_org, 'owner', true);

  INSERT INTO public.businesses (id, organization_id, name, country, base_currency, fiscal_year_start)
  VALUES (v_p, v_org, 'Nairobi Holdings Ltd', 'KE', 'KES', 1),
         (v_s, v_org, 'Delaware Ops Inc',     'US', 'USD', 1);

  -- A rate that moves every day: a static rate would hide every translation bug.
  INSERT INTO public.exchange_rates
    (organization_id, business_id, from_currency, to_currency, rate, effective_date, source, published_at)
  SELECT v_org, v_p, 'USD', 'KES', 100 + (d::date - DATE '2026-01-01') * 0.10, d::date, 'manual', now()
    FROM generate_series(DATE '2026-01-01', DATE '2026-03-31', INTERVAL '1 day') d;

  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_p, 'asset', 'cash_on_hand', '1000', 'Cash P') RETURNING id INTO v_cash_p;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_p, 'equity', 'common_stock', '3000', 'Share capital P') RETURNING id INTO v_cap_p;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_p, 'equity', 'accumulated_other_comprehensive_income', '3900',
          'Foreign currency translation reserve') RETURNING id INTO v_cta;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_s, 'asset', 'cash_on_hand', '1000', 'Cash S') RETURNING id INTO v_cash_s;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_s, 'equity', 'common_stock', '3000', 'Share capital S') RETURNING id INTO v_cap_s;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_s, 'income', 'sales_income', '4000', 'Revenue S') RETURNING id INTO v_rev_s;

  INSERT INTO public.journal_entries
    (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_p, 'SC2-P-1', DATE '2026-01-05', 'Capitalisation', 'draft', 'KES', 1) RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines (organization_id, business_id, journal_entry_id, account_id, debit, credit)
  VALUES (v_org, v_p, v_je, v_cash_p, 100000, 0), (v_org, v_p, v_je, v_cap_p, 0, 100000);
  UPDATE public.journal_entries SET status = 'posted', posted_at = now() WHERE id = v_je;

  -- Share capital is translated at the historical rate, not the closing rate.
  INSERT INTO public.journal_entries
    (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_s, 'SC2-S-1', v_hist, 'Share issue', 'draft', 'USD', 1) RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines (organization_id, business_id, journal_entry_id, account_id, debit, credit)
  VALUES (v_org, v_s, v_je, v_cash_s, 1000, 0), (v_org, v_s, v_je, v_cap_s, 0, 1000);
  UPDATE public.journal_entries SET status = 'posted', posted_at = now() WHERE id = v_je;

  INSERT INTO public.journal_entries
    (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_s, 'SC2-S-2', DATE '2026-03-20', 'Sale', 'draft', 'USD', 1) RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines (organization_id, business_id, journal_entry_id, account_id, debit, credit)
  VALUES (v_org, v_s, v_je, v_cash_s, 200, 0), (v_org, v_s, v_je, v_rev_s, 0, 200);
  UPDATE public.journal_entries SET status = 'posted', posted_at = now() WHERE id = v_je;

  INSERT INTO public.consolidation_groups
    (id, organization_id, name, parent_business_id, presentation_currency, cta_account_id)
  VALUES (v_group, v_org, 'Scenario Group 2', v_p, 'KES', v_cta);
  INSERT INTO public.consolidation_group_members
    (organization_id, group_id, business_id, ownership_percent, method, effective_from)
  VALUES (v_org, v_group, v_p, 100, 'full', DATE '2026-01-01');
  INSERT INTO public.consolidation_group_members
    (organization_id, group_id, business_id, parent_business_id, ownership_percent, method,
     effective_from, historical_rate_date)
  VALUES (v_org, v_group, v_s, v_p, 100, 'full', DATE '2026-01-01', v_hist);

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);

  SELECT r.closing_rate, r.average_rate INTO v_close, v_avg
    FROM public.consolidation_member_translation_rates(v_group, v_s, v_from, v_to) r;

  SELECT * INTO v_tot FROM public.get_consolidated_statement_totals(v_group, v_from, v_to);

  IF round(v_tot.total_assets, 2) <> round(100000 + 1200 * v_close, 2) THEN
    RAISE EXCEPTION 'assets % but 100000 KES plus 1200 USD at the closing rate % is %',
      v_tot.total_assets, v_close, round(100000 + 1200 * v_close, 2);
  END IF;
  IF round(v_tot.total_income, 2) <> round(200 * v_avg, 2) THEN
    RAISE EXCEPTION 'income % but 200 USD at the average rate % is %',
      v_tot.total_income, v_avg, round(200 * v_avg, 2);
  END IF;
  IF round(v_tot.total_income, 2) = round(200 * v_close, 2) THEN
    RAISE EXCEPTION 'income was translated at the closing rate, not the period average';
  END IF;
  IF v_tot.translation_reserve = 0 THEN
    RAISE EXCEPTION 'a moving rate produced no translation reserve';
  END IF;
  IF NOT v_tot.is_balanced THEN
    RAISE EXCEPTION 'the translated group balance sheet does not balance, difference %', v_tot.balance_difference;
  END IF;

  SELECT * INTO v_cta_rec FROM public.consolidation_cta_reconciliation(v_group, v_from, v_to) c
   WHERE c.business_id = v_s;
  IF v_cta_rec IS NULL THEN
    RAISE EXCEPTION 'no translation reserve proof for the foreign subsidiary';
  END IF;
  IF NOT v_cta_rec.is_reconciled THEN
    RAISE EXCEPTION 'CTA does not reconcile: movement % vs proof %, difference %',
      v_cta_rec.cta_movement, v_cta_rec.expected_cta_movement, v_cta_rec.movement_difference;
  END IF;

  RAISE EXCEPTION 'rollback: Block 2 OK — closing rate on assets (%), average rate on income (%), reserve % proven',
    v_tot.total_assets, v_tot.total_income, v_tot.translation_reserve;
END $$;

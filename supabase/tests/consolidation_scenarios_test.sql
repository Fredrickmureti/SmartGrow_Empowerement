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
  IF v_tot.total_equity <> 250000 THEN
    RAISE EXCEPTION 'group equity % but the members were capitalised 200000 + 50000', v_tot.total_equity;
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

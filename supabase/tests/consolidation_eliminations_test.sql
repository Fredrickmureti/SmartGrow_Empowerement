-- Brick 7 — elimination engine: contract and behaviour.
-- Run against a database with the consolidation migrations applied:
--   psql "$DATABASE_URL" -f supabase/tests/consolidation_eliminations_test.sql
-- Every block rolls itself back; nothing is committed.

-- ---------------------------------------------------------------------------
-- Block 1 — contract: security posture, no second ledger, hand-posting refused.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_secdef boolean;
  v_src text;
BEGIN
  FOR v_secdef, v_src IN
    SELECT p.prosecdef, p.prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('consolidation_intercompany_flows',
                         'consolidation_generate_eliminations',
                         'get_consolidated_statement_lines_eliminated',
                         'get_consolidated_statement_totals_eliminated')
  LOOP
    IF v_secdef THEN
      RAISE EXCEPTION 'elimination functions must be SECURITY INVOKER so member-level access is enforced';
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('consolidation_intercompany_flows',
                           'consolidation_generate_eliminations',
                           'get_consolidated_statement_lines_eliminated',
                           'get_consolidated_statement_totals_eliminated')) <> 4 THEN
    RAISE EXCEPTION 'the Brick 7 function set is incomplete';
  END IF;

  -- The engine must reuse the existing translation and scope machinery rather
  -- than reading rates or member lists of its own.
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'consolidation_intercompany_flows';
  IF v_src NOT LIKE '%get_consolidated_trial_balance_translated%' THEN
    RAISE EXCEPTION 'intercompany flows must translate through the consolidated trial balance';
  END IF;
  IF v_src NOT LIKE '%resolve_consolidation_scope%' THEN
    RAISE EXCEPTION 'intercompany flows must gate on the consolidation scope';
  END IF;
  IF v_src LIKE '%exchange_rates%' THEN
    RAISE EXCEPTION 'intercompany flows must not read the rate book directly';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'consolidation_generate_eliminations';
  IF v_src NOT LIKE '%consolidation_intercompany_flows%' THEN
    RAISE EXCEPTION 'the generator must build on the intercompany flow reader';
  END IF;

  -- anon must hold no privilege on either elimination table.
  IF EXISTS (SELECT 1 FROM information_schema.role_table_grants
              WHERE grantee = 'anon' AND table_schema = 'public'
                AND table_name IN ('consolidation_eliminations', 'consolidation_elimination_rules')) THEN
    RAISE EXCEPTION 'anon must hold no privilege on the elimination tables';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'consolidation_eliminations'
                    AND t.tgname = 'consolidation_eliminations_engine_only') THEN
    RAISE EXCEPTION 'generated eliminations must be protected from hand-posting';
  END IF;

  RAISE EXCEPTION 'BRICK7 CONTRACT OK';
END $$;

-- ---------------------------------------------------------------------------
-- Block 2 — behaviour: reciprocal elimination, balance, statement effect,
-- idempotent regeneration, disagreement policy, authorisation.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
  v_reader uuid := gen_random_uuid();
  v_p uuid := gen_random_uuid();
  v_s uuid := gen_random_uuid();
  v_group uuid := gen_random_uuid();
  v_cash_p uuid; v_due_p uuid; v_cap_p uuid; v_rev_p uuid;
  v_cash_s uuid; v_due_s uuid; v_cap_s uuid; v_exp_s uuid;
  v_ga_cash uuid; v_ga_due uuid; v_ga_owed uuid; v_ga_cap uuid;
  v_ga_rev uuid; v_ga_exp uuid; v_ga_diff uuid;
  v_c_sub uuid := gen_random_uuid();
  v_c_par uuid := gen_random_uuid();
  v_je uuid;
  v_from date := DATE '2026-03-01';
  v_to   date := DATE '2026-03-31';
  v_rows integer;
  v_dr numeric; v_cr numeric;
  v_amount numeric;
  v_t record;
  v_refused boolean;
BEGIN
  ------------------------------------------------------------------ fixture ---
  INSERT INTO auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  VALUES (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'elim-' || replace(v_user::text,'-','') || '@example.test', now(), now()),
         (v_reader, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'elim-' || replace(v_reader::text,'-','') || '@example.test', now(), now());
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Elim Org', 'elim-' || replace(v_org::text,'-',''));
  INSERT INTO public.user_roles (user_id, organization_id, role, is_active)
  VALUES (v_user, v_org, 'owner', true), (v_reader, v_org, 'accountant', true);

  INSERT INTO public.businesses
    (id, organization_id, name, country, base_currency, fiscal_year_start, tax_id, registration_number)
  VALUES (v_p, v_org, 'Elim Parent Ltd', 'KE', 'KES', 1, 'EP-TAX', 'EP-01'),
         (v_s, v_org, 'Elim Sub Ltd',    'KE', 'KES', 1, 'ES-TAX', 'ES-02');

  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_p, 'asset', 'cash_on_hand', '1000', 'Cash P') RETURNING id INTO v_cash_p;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_p, 'asset', 'other_current_asset', '1100', 'Due from members') RETURNING id INTO v_due_p;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_p, 'equity', 'common_stock', '3000', 'Share capital P') RETURNING id INTO v_cap_p;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_p, 'income', 'sales_income', '4000', 'Management fees P') RETURNING id INTO v_rev_p;

  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_s, 'asset', 'cash_on_hand', '1000', 'Cash S') RETURNING id INTO v_cash_s;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_s, 'liability', 'other_current_liabilities', '2100', 'Due to members') RETURNING id INTO v_due_s;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_s, 'equity', 'common_stock', '3000', 'Share capital S') RETURNING id INTO v_cap_s;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_s, 'expense', 'other_expense', '5000', 'Management fee charge S') RETURNING id INTO v_exp_s;

  INSERT INTO public.contacts (id, organization_id, business_id, name, type)
  VALUES (v_c_sub, v_org, v_p, 'Elim Sub Ltd', 'customer'),
         (v_c_par, v_org, v_s, 'Elim Parent Ltd', 'supplier');

  -- Capitalisation of both members.
  INSERT INTO public.journal_entries
    (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_p, 'EL-P-1', v_from, 'Capitalisation', 'draft', 'KES', 1) RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines (organization_id, business_id, journal_entry_id, account_id, debit, credit)
  VALUES (v_org, v_p, v_je, v_cash_p, 200000, 0), (v_org, v_p, v_je, v_cap_p, 0, 200000);
  UPDATE public.journal_entries SET status = 'posted', posted_at = now() WHERE id = v_je;

  INSERT INTO public.journal_entries
    (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_s, 'EL-S-1', v_from, 'Capitalisation', 'draft', 'KES', 1) RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines (organization_id, business_id, journal_entry_id, account_id, debit, credit)
  VALUES (v_org, v_s, v_je, v_cash_s, 50000, 0), (v_org, v_s, v_je, v_cap_s, 0, 50000);
  UPDATE public.journal_entries SET status = 'posted', posted_at = now() WHERE id = v_je;

  -- The intra-group recharge, booked by both sides at 5,000.
  INSERT INTO public.journal_entries
    (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_p, 'EL-P-2', DATE '2026-03-10', 'Recharge to subsidiary', 'draft', 'KES', 1) RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines
    (organization_id, business_id, journal_entry_id, account_id, contact_id, debit, credit)
  VALUES (v_org, v_p, v_je, v_due_p, v_c_sub, 5000, 0),
         (v_org, v_p, v_je, v_rev_p, NULL,       0, 5000);
  UPDATE public.journal_entries SET status = 'posted', posted_at = now() WHERE id = v_je;

  INSERT INTO public.journal_entries
    (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_s, 'EL-S-2', DATE '2026-03-10', 'Recharge from parent', 'draft', 'KES', 1) RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines
    (organization_id, business_id, journal_entry_id, account_id, contact_id, debit, credit)
  VALUES (v_org, v_s, v_je, v_exp_s, NULL,    5000, 0),
         (v_org, v_s, v_je, v_due_s, v_c_par,    0, 5000);
  UPDATE public.journal_entries SET status = 'posted', posted_at = now() WHERE id = v_je;

  INSERT INTO public.consolidation_groups
    (id, organization_id, name, parent_business_id, presentation_currency)
  VALUES (v_group, v_org, 'Elim Group', v_p, 'KES');
  INSERT INTO public.consolidation_group_members
    (organization_id, group_id, business_id, ownership_percent, method, effective_from)
  VALUES (v_org, v_group, v_p, 100, 'full', DATE '2026-01-01');
  INSERT INTO public.consolidation_group_members
    (organization_id, group_id, business_id, parent_business_id, ownership_percent, method, effective_from)
  VALUES (v_org, v_group, v_s, v_p, 100, 'full', DATE '2026-01-01');

  INSERT INTO public.consolidation_group_accounts (organization_id, group_id, code, name, account_type, sort_order)
  VALUES (v_org, v_group, 'G-1000', 'Group cash', 'asset', 10) RETURNING id INTO v_ga_cash;
  INSERT INTO public.consolidation_group_accounts (organization_id, group_id, code, name, account_type, sort_order)
  VALUES (v_org, v_group, 'G-1100', 'Group due from members', 'asset', 20) RETURNING id INTO v_ga_due;
  INSERT INTO public.consolidation_group_accounts (organization_id, group_id, code, name, account_type, sort_order)
  VALUES (v_org, v_group, 'G-2100', 'Group due to members', 'liability', 30) RETURNING id INTO v_ga_owed;
  INSERT INTO public.consolidation_group_accounts (organization_id, group_id, code, name, account_type, sort_order)
  VALUES (v_org, v_group, 'G-3000', 'Group share capital', 'equity', 40) RETURNING id INTO v_ga_cap;
  INSERT INTO public.consolidation_group_accounts (organization_id, group_id, code, name, account_type, sort_order)
  VALUES (v_org, v_group, 'G-4000', 'Group revenue', 'income', 50) RETURNING id INTO v_ga_rev;
  INSERT INTO public.consolidation_group_accounts (organization_id, group_id, code, name, account_type, sort_order)
  VALUES (v_org, v_group, 'G-5000', 'Group operating costs', 'expense', 60) RETURNING id INTO v_ga_exp;
  INSERT INTO public.consolidation_group_accounts (organization_id, group_id, code, name, account_type, sort_order)
  VALUES (v_org, v_group, 'G-9900', 'Unreconciled intercompany difference', 'expense', 90) RETURNING id INTO v_ga_diff;

  INSERT INTO public.consolidation_account_mappings
    (organization_id, group_id, business_id, account_id, group_account_id, effective_from)
  VALUES (v_org, v_group, v_p, v_cash_p, v_ga_cash, DATE '2026-01-01'),
         (v_org, v_group, v_p, v_due_p,  v_ga_due,  DATE '2026-01-01'),
         (v_org, v_group, v_p, v_cap_p,  v_ga_cap,  DATE '2026-01-01'),
         (v_org, v_group, v_p, v_rev_p,  v_ga_rev,  DATE '2026-01-01'),
         (v_org, v_group, v_s, v_cash_s, v_ga_cash, DATE '2026-01-01'),
         (v_org, v_group, v_s, v_due_s,  v_ga_owed, DATE '2026-01-01'),
         (v_org, v_group, v_s, v_cap_s,  v_ga_cap,  DATE '2026-01-01'),
         (v_org, v_group, v_s, v_exp_s,  v_ga_exp,  DATE '2026-01-01');

  INSERT INTO public.consolidation_intercompany_partners
    (organization_id, group_id, business_id, contact_id, counterparty_business_id, effective_from)
  VALUES (v_org, v_group, v_p, v_c_sub, v_s, DATE '2026-01-01'),
         (v_org, v_group, v_s, v_c_par, v_p, DATE '2026-01-01');

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);

  -------------------------------------------------------------- 1. generate ---
  PERFORM public.consolidation_generate_eliminations(v_group, v_from, v_to);

  SELECT count(*), round(sum(debit), 2), round(sum(credit), 2)
    INTO v_rows, v_dr, v_cr
    FROM public.consolidation_eliminations
   WHERE group_id = v_group AND period_start = v_from AND period_end = v_to;
  IF v_rows <> 4 THEN
    RAISE EXCEPTION 'expected four elimination legs (two positions, two trading), got %', v_rows;
  END IF;
  IF v_dr <> v_cr THEN
    RAISE EXCEPTION 'eliminations must balance: debit % vs credit %', v_dr, v_cr;
  END IF;
  IF v_dr <> 10000 THEN
    RAISE EXCEPTION 'expected 10000 eliminated on each side, got %', v_dr;
  END IF;

  -- The receivable is credited away and the matching payable debited away.
  SELECT credit INTO v_amount FROM public.consolidation_eliminations
   WHERE group_id = v_group AND group_account_id = v_ga_due;
  IF v_amount <> 5000 THEN
    RAISE EXCEPTION 'the intercompany receivable must be credited away in full, got %', v_amount;
  END IF;
  SELECT debit INTO v_amount FROM public.consolidation_eliminations
   WHERE group_id = v_group AND group_account_id = v_ga_owed;
  IF v_amount <> 5000 THEN
    RAISE EXCEPTION 'the intercompany payable must be debited away in full, got %', v_amount;
  END IF;

  ------------------------------------------------- 2. effect on statements ---
  SELECT * INTO v_t FROM public.get_consolidated_statement_totals_eliminated(v_group, v_from, v_to);
  IF v_t.total_income <> 0 THEN
    RAISE EXCEPTION 'intra-group revenue must not survive consolidation, got %', v_t.total_income;
  END IF;
  IF v_t.total_expense <> 0 THEN
    RAISE EXCEPTION 'intra-group cost must not survive consolidation, got %', v_t.total_expense;
  END IF;
  IF v_t.total_assets <> 250000 THEN
    RAISE EXCEPTION 'consolidated assets expected 250000 (cash only), got %', v_t.total_assets;
  END IF;
  IF v_t.total_liabilities <> 0 THEN
    RAISE EXCEPTION 'the intercompany payable must not survive consolidation, got %', v_t.total_liabilities;
  END IF;
  IF NOT v_t.is_balanced THEN
    RAISE EXCEPTION 'the eliminated balance sheet must still balance, difference %', v_t.balance_sheet_difference;
  END IF;

  -- The aggregated column still shows the gross figures: eliminations explain
  -- the move, they do not hide it.
  SELECT aggregated_amount INTO v_amount
    FROM public.get_consolidated_statement_lines_eliminated(v_group, v_from, v_to)
   WHERE account_id = v_ga_rev;
  IF v_amount <> 5000 THEN
    RAISE EXCEPTION 'the aggregated revenue column must still show 5000, got %', v_amount;
  END IF;

  ------------------------------------------------------- 3. regeneration is ---
  -- idempotent: the previous set is replaced, never doubled.
  PERFORM public.consolidation_generate_eliminations(v_group, v_from, v_to);
  SELECT count(*), round(sum(debit), 2) INTO v_rows, v_dr
    FROM public.consolidation_eliminations
   WHERE group_id = v_group AND period_start = v_from AND period_end = v_to;
  IF v_rows <> 4 OR v_dr <> 10000 THEN
    RAISE EXCEPTION 'regeneration must replace the previous set, got % rows totalling %', v_rows, v_dr;
  END IF;

  ------------------------------------------------- 4. eliminations are engine ---
  -- output only: nobody can type one in.
  v_refused := false;
  BEGIN
    INSERT INTO public.consolidation_eliminations
      (organization_id, group_id, period_start, period_end, elimination_class,
       declaring_business_id, counterparty_business_id, group_account_id,
       group_account_code, group_account_name, account_type, presentation_currency, debit)
    VALUES (v_org, v_group, v_from, v_to, 'intercompany_balance', v_p, v_s, v_ga_cash,
            'G-1000', 'Group cash', 'asset', 'KES', 1);
  EXCEPTION WHEN insufficient_privilege THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'a hand-written elimination must be refused';
  END IF;

  ------------------------------------------------------- 5. disagreements ---
  -- The subsidiary restates its side down to 4,800 the only way the ledger
  -- allows: posted lines are immutable, so it books a correcting entry.
  INSERT INTO public.journal_entries
    (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_s, 'EL-S-3', DATE '2026-03-20', 'Recharge correction', 'draft', 'KES', 1) RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines
    (organization_id, business_id, journal_entry_id, account_id, contact_id, debit, credit)
  VALUES (v_org, v_s, v_je, v_due_s, v_c_par, 200, 0),
         (v_org, v_s, v_je, v_exp_s, NULL,      0, 200);
  UPDATE public.journal_entries SET status = 'posted', posted_at = now() WHERE id = v_je;


  v_refused := false;
  BEGIN
    PERFORM public.consolidation_generate_eliminations(v_group, v_from, v_to);
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%differ by%' THEN RAISE; END IF;
    v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'a reciprocal disagreement must refuse the run by default';
  END IF;

  -- With an explicit policy the difference is posted where it can be seen.
  INSERT INTO public.consolidation_elimination_rules
    (organization_id, group_id, elimination_class, tolerance_amount, difference_policy,
     difference_group_account_id)
  VALUES (v_org, v_group, 'intercompany_balance', 0, 'post_difference', v_ga_diff),
         (v_org, v_group, 'intercompany_trading', 0, 'post_difference', v_ga_diff);

  PERFORM public.consolidation_generate_eliminations(v_group, v_from, v_to);
  SELECT round(sum(debit), 2), round(sum(credit), 2) INTO v_dr, v_cr
    FROM public.consolidation_eliminations
   WHERE group_id = v_group AND period_start = v_from AND period_end = v_to;
  IF v_dr <> v_cr THEN
    RAISE EXCEPTION 'eliminations with a posted difference must still balance: % vs %', v_dr, v_cr;
  END IF;
  SELECT round(sum(debit - credit), 2) INTO v_amount
    FROM public.consolidation_eliminations
   WHERE group_id = v_group AND is_difference;
  IF v_amount <> 400 THEN
    RAISE EXCEPTION 'the two 200 disagreements must surface as 400 of difference, got %', v_amount;
  END IF;

  SELECT * INTO v_t FROM public.get_consolidated_statement_totals_eliminated(v_group, v_from, v_to);
  IF NOT v_t.is_balanced THEN
    RAISE EXCEPTION 'the balance sheet must balance even when the sides disagree, difference %',
      v_t.balance_sheet_difference;
  END IF;

  ------------------------------------------------------- 6. authorisation ---
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_reader::text, 'role', 'authenticated')::text, true);
  v_refused := false;
  BEGIN
    PERFORM public.consolidation_generate_eliminations(v_group, v_from, v_to);
  EXCEPTION WHEN insufficient_privilege THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'a user without write authority must not be able to generate eliminations';
  END IF;

  RAISE EXCEPTION 'BRICK7 BEHAVIOUR OK';
END $$;

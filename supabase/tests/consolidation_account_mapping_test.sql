-- Consolidation — group chart of accounts and account mapping (Brick 4).
--   psql "$DATABASE_URL" -f supabase/tests/consolidation_account_mapping_test.sql
--
-- WHAT THIS PROVES
-- Member companies keep their own charts of accounts. A group statement may
-- therefore only be produced through explicit, auditable mapping rows — never
-- by matching account codes at read time, and never by silently dropping or
-- passing through an account nobody mapped. This suite proves:
--
--   * two companies with entirely different account codes merge into ONE line
--     per group account, and the merged figure is the sum of the members;
--   * a posted balance in an unmapped account REFUSES the report and names the
--     offending accounts (no manufactured figure, no silent omission);
--   * a group with no group chart is the identity case — the report is keyed by
--     the member account and is not refused;
--   * a mapping across account types is rejected;
--   * a second mapping overlapping the same period for one account is rejected;
--   * the translation reserve cannot be mapped as an ordinary line;
--   * every mapping change is recorded in the consolidation change log;
--   * a foreign organization can read neither the group chart nor the mappings,
--     and the owning user is not over-blocked.
--
-- SAFETY
-- Both blocks seed their own organizations and end by raising, so the
-- transaction rolls back and no fixture row survives the run.

-- ---------------------------------------------------------------------------
-- 1) Contract: tables, RLS, grants, and the read path that must consume them.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_t text; v_rel regclass; v_src text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['consolidation_group_accounts', 'consolidation_account_mappings'] LOOP
    v_rel := ('public.' || v_t)::regclass;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_rel) THEN
      RAISE EXCEPTION 'public.% does not have row level security enabled', v_t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = v_t) THEN
      RAISE EXCEPTION 'public.% has row level security but no policies', v_t;
    END IF;
    IF has_table_privilege('anon', v_rel, 'SELECT') THEN
      RAISE EXCEPTION 'anon must not read public.%', v_t;
    END IF;
    IF NOT has_table_privilege('authenticated', v_rel, 'SELECT') THEN
      RAISE EXCEPTION 'authenticated cannot read public.% — the Data API needs an explicit grant', v_t;
    END IF;
    IF NOT has_table_privilege('service_role', v_rel, 'INSERT') THEN
      RAISE EXCEPTION 'service_role cannot write public.%', v_t;
    END IF;
  END LOOP;

  -- Coverage helpers run with the caller's own permissions, so RLS still applies.
  FOREACH v_t IN ARRAY ARRAY['consolidation_unmapped_accounts', 'consolidation_group_uses_group_chart'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = v_t) THEN
      RAISE EXCEPTION '% is missing', v_t;
    END IF;
    IF (SELECT bool_or(p.prosecdef) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = v_t) THEN
      RAISE EXCEPTION '% must run with the caller''s own permissions', v_t;
    END IF;
  END LOOP;

  -- The engine must resolve the mapping itself: mapping is an accounting rule,
  -- not a presentation detail the client may re-implement.
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_consolidated_trial_balance_translated';
  IF v_src NOT LIKE '%consolidation_account_mappings%' THEN
    RAISE EXCEPTION 'the translated trial balance does not resolve group account mappings';
  END IF;
  IF v_src NOT LIKE '%consolidation_unmapped_accounts%' THEN
    RAISE EXCEPTION 'the translated trial balance does not refuse unmapped posted accounts';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_consolidated_statement_lines';
  IF v_src NOT LIKE '%group_account_id%' THEN
    RAISE EXCEPTION 'the consolidated statements do not aggregate on the group account';
  END IF;

  RAISE NOTICE 'consolidation account mapping: contract checks passed';
END $$;

-- ---------------------------------------------------------------------------
-- 2) Behaviour: two different charts, one group chart.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_org_b uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
  v_user_b uuid := gen_random_uuid();
  v_p uuid := gen_random_uuid();
  v_s uuid := gen_random_uuid();
  v_group uuid := gen_random_uuid();
  v_plain uuid := gen_random_uuid();
  v_cta uuid;
  v_cash_p uuid; v_cap_p uuid; v_rev_p uuid; v_exp_p uuid;
  v_cash_s uuid; v_cap_s uuid; v_rev_s uuid; v_exp_s uuid;
  v_ga_cash uuid; v_ga_cap uuid; v_ga_rev uuid; v_ga_exp uuid;
  v_je uuid;
  v_from date := DATE '2026-03-01';
  v_to date := DATE '2026-03-31';
  v_rows integer;
  v_amount numeric;
  v_msg text;
  v_refused boolean;
BEGIN
  -- ===== fixture ==========================================================
  INSERT INTO auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  VALUES (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'consol-map-' || replace(v_user::text,'-','') || '@example.test', now(), now()),
         (v_user_b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'consol-map-' || replace(v_user_b::text,'-','') || '@example.test', now(), now());
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Mapping Org A', 'consol-map-' || replace(v_org::text,'-','')),
         (v_org_b, 'Mapping Org B', 'consol-map-' || replace(v_org_b::text,'-',''));
  INSERT INTO public.user_roles (user_id, organization_id, role, is_active)
  VALUES (v_user, v_org, 'owner', true), (v_user_b, v_org_b, 'owner', true);

  -- Both companies report in KES: this suite is about chart merging, and the
  -- translation suites already prove the rate mathematics.
  INSERT INTO public.businesses (id, organization_id, name, country, base_currency, fiscal_year_start)
  VALUES (v_p, v_org, 'Map Parent Ltd', 'KE', 'KES', 1),
         (v_s, v_org, 'Map Sub Ltd', 'KE', 'KES', 1);

  -- Deliberately non-overlapping code schemes: code matching cannot pass here.
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_p, 'asset', 'cash_on_hand', '1000', 'Cash P') RETURNING id INTO v_cash_p;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_p, 'equity', 'common_stock', '3000', 'Share capital P') RETURNING id INTO v_cap_p;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_p, 'income', 'sales_income', '4000', 'Sales P') RETURNING id INTO v_rev_p;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_p, 'expense', 'other_expense', '5000', 'Costs P') RETURNING id INTO v_exp_p;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_p, 'equity', 'accumulated_other_comprehensive_income', '3900', 'Translation reserve') RETURNING id INTO v_cta;

  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_s, 'asset', 'cash_on_hand', 'CB-01', 'Bank S') RETURNING id INTO v_cash_s;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_s, 'equity', 'common_stock', 'EQ-01', 'Capital S') RETURNING id INTO v_cap_s;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_s, 'income', 'sales_income', 'RV-01', 'Turnover S') RETURNING id INTO v_rev_s;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_s, 'expense', 'other_expense', 'CS-01', 'Cost of sales S') RETURNING id INTO v_exp_s;

  INSERT INTO public.journal_entries (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_p, 'MAP-P-1', v_from, 'Capital and trading', 'draft', 'KES', 1) RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines (organization_id, business_id, journal_entry_id, account_id, debit, credit)
  VALUES (v_org, v_p, v_je, v_cash_p, 100000, 0), (v_org, v_p, v_je, v_cap_p, 0, 100000),
         (v_org, v_p, v_je, v_cash_p, 60000, 0), (v_org, v_p, v_je, v_rev_p, 0, 60000),
         (v_org, v_p, v_je, v_exp_p, 25000, 0), (v_org, v_p, v_je, v_cash_p, 0, 25000);
  UPDATE public.journal_entries SET status = 'posted', posted_at = now() WHERE id = v_je;

  INSERT INTO public.journal_entries (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_s, 'MAP-S-1', v_from, 'Capital and trading', 'draft', 'KES', 1) RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines (organization_id, business_id, journal_entry_id, account_id, debit, credit)
  VALUES (v_org, v_s, v_je, v_cash_s, 40000, 0), (v_org, v_s, v_je, v_cap_s, 0, 40000),
         (v_org, v_s, v_je, v_cash_s, 15000, 0), (v_org, v_s, v_je, v_rev_s, 0, 15000),
         (v_org, v_s, v_je, v_exp_s, 5000, 0), (v_org, v_s, v_je, v_cash_s, 0, 5000);
  UPDATE public.journal_entries SET status = 'posted', posted_at = now() WHERE id = v_je;

  INSERT INTO public.consolidation_groups (id, organization_id, name, parent_business_id, presentation_currency, cta_account_id)
  VALUES (v_group, v_org, 'Mapping Group', v_p, 'KES', v_cta);
  INSERT INTO public.consolidation_group_members (organization_id, group_id, business_id, ownership_percent, method, effective_from)
  VALUES (v_org, v_group, v_p, 100, 'full', DATE '2026-01-01');
  INSERT INTO public.consolidation_group_members (organization_id, group_id, business_id, parent_business_id, ownership_percent, method, effective_from)
  VALUES (v_org, v_group, v_s, v_p, 100, 'full', DATE '2026-01-01');

  -- A single-chart control group: same parent, no group chart of its own.
  INSERT INTO public.consolidation_groups (id, organization_id, name, parent_business_id, presentation_currency, cta_account_id)
  VALUES (v_plain, v_org, 'Mapping Control Group', v_p, 'KES', v_cta);
  INSERT INTO public.consolidation_group_members (organization_id, group_id, business_id, ownership_percent, method, effective_from)
  VALUES (v_org, v_plain, v_p, 100, 'full', DATE '2026-01-01');

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);

  -- ===== A: identity case — no group chart, no refusal ====================
  SELECT count(*) INTO v_rows
    FROM public.get_consolidated_trial_balance_translated(v_plain, v_from, v_to) t
   WHERE t.is_mapped;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'a group with no group chart reported mapped lines';
  END IF;
  SELECT count(*) INTO v_rows
    FROM public.get_consolidated_trial_balance_translated(v_plain, v_from, v_to) t
   WHERE t.group_account_id IS DISTINCT FROM t.account_id;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'without a group chart the group account must be the member account';
  END IF;

  -- ===== B: group chart present but nothing mapped — the report refuses ===
  INSERT INTO public.consolidation_group_accounts (organization_id, group_id, code, name, account_type, sort_order)
  VALUES (v_org, v_group, 'G-1000', 'Group cash and bank', 'asset', 10) RETURNING id INTO v_ga_cash;
  INSERT INTO public.consolidation_group_accounts (organization_id, group_id, code, name, account_type, sort_order)
  VALUES (v_org, v_group, 'G-3000', 'Group share capital', 'equity', 20) RETURNING id INTO v_ga_cap;
  INSERT INTO public.consolidation_group_accounts (organization_id, group_id, code, name, account_type, sort_order)
  VALUES (v_org, v_group, 'G-4000', 'Group revenue', 'income', 30) RETURNING id INTO v_ga_rev;
  INSERT INTO public.consolidation_group_accounts (organization_id, group_id, code, name, account_type, sort_order)
  VALUES (v_org, v_group, 'G-5000', 'Group cost of sales', 'expense', 40) RETURNING id INTO v_ga_exp;

  SELECT count(*) INTO v_rows FROM public.consolidation_unmapped_accounts(v_group, v_from, v_to);
  IF v_rows < 8 THEN
    RAISE EXCEPTION 'the unmapped worklist found only % accounts; both charts should be listed', v_rows;
  END IF;

  v_refused := false;
  BEGIN
    PERFORM count(*) FROM public.get_consolidated_trial_balance_translated(v_group, v_from, v_to);
  EXCEPTION WHEN others THEN
    v_refused := true;
    v_msg := SQLERRM;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'the report produced figures while posted accounts had no group mapping';
  END IF;
  IF v_msg NOT LIKE '%CB-01%' OR v_msg NOT LIKE '%1000%' THEN
    RAISE EXCEPTION 'the refusal does not name the offending accounts: %', v_msg;
  END IF;

  -- The statements are a projection, so they must refuse for the same reason.
  v_refused := false;
  BEGIN
    PERFORM * FROM public.get_consolidated_statement_totals(v_group, v_from, v_to);
  EXCEPTION WHEN others THEN v_refused := true; END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'the statements reported figures the trial balance refuses';
  END IF;

  -- ===== C: a cross-type mapping is rejected =============================
  v_refused := false;
  BEGIN
    INSERT INTO public.consolidation_account_mappings
      (organization_id, group_id, business_id, account_id, group_account_id, effective_from)
    VALUES (v_org, v_group, v_p, v_cash_p, v_ga_rev, DATE '2026-01-01');
  EXCEPTION WHEN others THEN v_refused := true; END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'an asset account was allowed to map to an income group account';
  END IF;

  -- ===== D: the translation reserve is not mappable ======================
  v_refused := false;
  BEGIN
    INSERT INTO public.consolidation_account_mappings
      (organization_id, group_id, business_id, account_id, group_account_id, effective_from)
    VALUES (v_org, v_group, v_p, v_cta, v_ga_cap, DATE '2026-01-01');
  EXCEPTION WHEN others THEN v_refused := true; END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'the group translation reserve was allowed to be mapped as an ordinary line';
  END IF;

  -- ===== E: an account of a non-member company is rejected ===============
  v_refused := false;
  BEGIN
    INSERT INTO public.consolidation_account_mappings
      (organization_id, group_id, business_id, account_id, group_account_id, effective_from)
    VALUES (v_org, v_plain, v_s, v_cash_s, v_ga_cash, DATE '2026-01-01');
  EXCEPTION WHEN others THEN v_refused := true; END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'an account of a non-member company was mapped into a group';
  END IF;

  -- ===== F: map both charts onto the group chart =========================
  INSERT INTO public.consolidation_account_mappings
    (organization_id, group_id, business_id, account_id, group_account_id, effective_from)
  VALUES (v_org, v_group, v_p, v_cash_p, v_ga_cash, DATE '2026-01-01'),
         (v_org, v_group, v_p, v_cap_p,  v_ga_cap,  DATE '2026-01-01'),
         (v_org, v_group, v_p, v_rev_p,  v_ga_rev,  DATE '2026-01-01'),
         (v_org, v_group, v_p, v_exp_p,  v_ga_exp,  DATE '2026-01-01'),
         (v_org, v_group, v_s, v_cash_s, v_ga_cash, DATE '2026-01-01'),
         (v_org, v_group, v_s, v_cap_s,  v_ga_cap,  DATE '2026-01-01'),
         (v_org, v_group, v_s, v_rev_s,  v_ga_rev,  DATE '2026-01-01'),
         (v_org, v_group, v_s, v_exp_s,  v_ga_exp,  DATE '2026-01-01');

  -- ===== G: an overlapping second mapping is rejected ====================
  v_refused := false;
  BEGIN
    INSERT INTO public.consolidation_account_mappings
      (organization_id, group_id, business_id, account_id, group_account_id, effective_from)
    VALUES (v_org, v_group, v_p, v_rev_p, v_ga_rev, DATE '2026-02-01');
  EXCEPTION WHEN others THEN v_refused := true; END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'one account was allowed two group mappings covering the same period';
  END IF;

  -- ===== H: two charts merge into one line per group account =============
  SELECT count(*) INTO v_rows FROM public.consolidation_unmapped_accounts(v_group, v_from, v_to);
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'the unmapped worklist still reports % accounts after mapping every one', v_rows;
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.get_consolidated_trial_balance_translated(v_group, v_from, v_to) t
   WHERE NOT t.is_mapped AND t.rate_class <> 'residual';
  IF v_rows <> 0 THEN
    RAISE EXCEPTION '% posted lines came back unmapped after mapping', v_rows;
  END IF;

  -- Both companies contribute to G-4000, and it is one line, not two.
  SELECT count(*) INTO v_rows
    FROM public.get_consolidated_statement_lines(v_group, v_from, v_to) l
   WHERE l.account_code = 'G-4000';
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'group revenue produced % lines instead of one', v_rows;
  END IF;

  SELECT l.amount INTO v_amount
    FROM public.get_consolidated_statement_lines(v_group, v_from, v_to) l
   WHERE l.account_code = 'G-4000';
  IF round(v_amount, 2) <> 75000.00 THEN
    RAISE EXCEPTION 'group revenue is % but the members posted 60000 + 15000', v_amount;
  END IF;

  SELECT l.amount INTO v_amount
    FROM public.get_consolidated_statement_lines(v_group, v_from, v_to) l
   WHERE l.account_code = 'G-5000';
  IF round(v_amount, 2) <> 30000.00 THEN
    RAISE EXCEPTION 'group cost of sales is % but the members posted 25000 + 5000', v_amount;
  END IF;

  SELECT l.amount INTO v_amount
    FROM public.get_consolidated_statement_lines(v_group, v_from, v_to) l
   WHERE l.account_code = 'G-1000';
  IF round(v_amount, 2) <> 185000.00 THEN
    RAISE EXCEPTION 'group cash is % but the members hold 135000 + 50000', v_amount;
  END IF;

  -- No member account may leak onto the group statement alongside its group line.
  SELECT count(*) INTO v_rows
    FROM public.get_consolidated_statement_lines(v_group, v_from, v_to) l
   WHERE l.account_code IN ('1000', '3000', '4000', '5000', 'CB-01', 'EQ-01', 'RV-01', 'CS-01');
  IF v_rows <> 0 THEN
    RAISE EXCEPTION '% member account lines leaked onto the group statement', v_rows;
  END IF;

  -- Drill-down survives: the member account is still on every trial balance row.
  SELECT count(*) INTO v_rows
    FROM public.get_consolidated_trial_balance_translated(v_group, v_from, v_to) t
   WHERE t.account_id IS NULL OR t.account_code IS NULL;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'mapping destroyed the drill-down to the originating account';
  END IF;

  -- ===== I: every mapping change is logged ==============================
  SELECT count(*) INTO v_rows
    FROM public.consolidation_group_change_log
   WHERE group_id = v_group;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'the group chart and mapping changes were not recorded in the change log';
  END IF;

  -- ===== J: RLS — the foreign organization sees nothing =================
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user_b::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT count(*) INTO v_rows FROM public.consolidation_group_accounts WHERE group_id = v_group;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'LEAK: a foreign organization can read the group chart of accounts';
  END IF;
  SELECT count(*) INTO v_rows FROM public.consolidation_account_mappings WHERE group_id = v_group;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'LEAK: a foreign organization can read the account mappings';
  END IF;

  -- ===== K: the owner is not over-blocked ===============================
  RESET ROLE;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT count(*) INTO v_rows FROM public.consolidation_group_accounts WHERE group_id = v_group;
  IF v_rows <> 4 THEN
    RAISE EXCEPTION 'OVER-BLOCK: the owning user reads % of 4 group accounts', v_rows;
  END IF;
  SELECT count(*) INTO v_rows FROM public.consolidation_account_mappings WHERE group_id = v_group;
  IF v_rows <> 8 THEN
    RAISE EXCEPTION 'OVER-BLOCK: the owning user reads % of 8 mappings', v_rows;
  END IF;

  RESET ROLE;
  RAISE EXCEPTION 'rollback: consolidation account mapping passed (group revenue 75000, cost 30000, cash 185000)';
END $$;

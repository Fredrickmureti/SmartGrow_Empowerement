-- Brick 6 — intercompany identification: database invariants and behaviour.
-- Run against a database with the consolidation migrations applied:
--   psql "$DATABASE_URL" -f supabase/tests/consolidation_intercompany_test.sql
-- Both blocks roll back; nothing is committed.

-- ---------------------------------------------------------------------------
-- Block 1 — contract: security posture, refusal behaviour, no second engine.
-- ---------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
  v_secdef boolean;
  v_src text;
BEGIN
  SELECT p.prosecdef, p.prosrc INTO v_secdef, v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'consolidation_intercompany_balances';
  IF v_secdef IS NULL THEN
    RAISE EXCEPTION 'missing function public.consolidation_intercompany_balances';
  END IF;
  IF v_secdef THEN
    RAISE EXCEPTION 'consolidation_intercompany_balances must be SECURITY INVOKER so member-level access is enforced';
  END IF;

  -- The report reads the authoritative AR/AP sub-ledger projections and the
  -- existing group rate resolver; it must not build a second ledger or a
  -- second rate book of its own.
  IF v_src NOT LIKE '%customer_ledger_entries%' OR v_src NOT LIKE '%vendor_ledger_entries%' THEN
    RAISE EXCEPTION 'intercompany balances must read the AR/AP sub-ledger views';
  END IF;
  IF v_src NOT LIKE '%consolidation_member_translation_rates%' THEN
    RAISE EXCEPTION 'intercompany balances must translate through the group rate resolver';
  END IF;
  IF v_src NOT LIKE '%resolve_consolidation_scope%' THEN
    RAISE EXCEPTION 'intercompany balances must gate on the consolidation scope';
  END IF;
  IF v_src ~* 'COALESCE\s*\(\s*[a-z_.]*rate[a-z_.]*\s*,\s*1\s*\)' THEN
    RAISE EXCEPTION 'a missing rate must be refused, never defaulted to 1:1';
  END IF;

  -- Signed-in users may run it; anonymous callers may not.
  IF NOT has_function_privilege('authenticated',
        'public.consolidation_intercompany_balances(uuid, date, date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must be able to execute consolidation_intercompany_balances';
  END IF;
  IF has_function_privilege('anon',
        'public.consolidation_intercompany_balances(uuid, date, date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not execute consolidation_intercompany_balances';
  END IF;

  -- The declaration table is row-level secured and not readable anonymously.
  IF NOT (SELECT relrowsecurity FROM pg_class
           WHERE oid = 'public.consolidation_intercompany_partners'::regclass) THEN
    RAISE EXCEPTION 'consolidation_intercompany_partners must have RLS enabled';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE grantee = 'anon' AND table_schema = 'public'
       AND table_name = 'consolidation_intercompany_partners'
  ) THEN
    RAISE EXCEPTION 'anon must hold no privilege on consolidation_intercompany_partners';
  END IF;

  -- Refusals: unknown group, inverted range.
  BEGIN
    PERFORM * FROM public.consolidation_intercompany_balances(
      '00000000-0000-0000-0000-000000000000'::uuid, current_date - 30, current_date);
    RAISE EXCEPTION 'an unknown group must be refused';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- expected
  END;
  BEGIN
    PERFORM * FROM public.consolidation_intercompany_balances(
      '00000000-0000-0000-0000-000000000000'::uuid, current_date, current_date - 1);
    RAISE EXCEPTION 'an inverted date range must be refused';
  EXCEPTION WHEN others THEN
    NULL; -- expected
  END;

  RAISE NOTICE 'Brick 6 intercompany contract: OK';
END $$;

ROLLBACK;

-- ---------------------------------------------------------------------------
-- Block 2 — behaviour: reciprocal pairing, asymmetry surfaced, guard rules.
-- ---------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
  v_org uuid;
  v_p uuid := gen_random_uuid();
  v_s uuid := gen_random_uuid();
  v_group uuid := gen_random_uuid();
  v_ar uuid;
  v_ap uuid;

  v_inc uuid := gen_random_uuid();
  v_exp uuid := gen_random_uuid();
  v_c_sub uuid := gen_random_uuid();
  v_c_par uuid := gen_random_uuid();
  v_je uuid;
  v_r record;
BEGIN
  SELECT id INTO v_org FROM public.organizations ORDER BY created_at LIMIT 1;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'no organization available to test against';
  END IF;

  INSERT INTO public.businesses (id, organization_id, name, country, base_currency)
  VALUES (v_p, v_org, 'IC Parent Ltd', 'KE', 'KES'),
         (v_s, v_org, 'IC Sub Ltd',    'KE', 'KES');

  INSERT INTO public.consolidation_groups
    (id, organization_id, name, parent_business_id, presentation_currency)
  VALUES (v_group, v_org, 'IC Test Group', v_p, 'KES');

  INSERT INTO public.consolidation_group_members
    (organization_id, group_id, business_id, parent_business_id, ownership_percent)
  VALUES (v_org, v_group, v_p, NULL, 100),
         (v_org, v_group, v_s, v_p,  100);

  -- AR/AP control accounts must be provisioned through the system-account
  -- helper; a direct INSERT of system_role is refused by the accounts guard.
  v_ar := public.upsert_system_account(v_org, v_p, 'accounts_receivable', 'asset',
            'accounts_receivable', 'IC-AR', 'Trade receivables');
  v_ap := public.upsert_system_account(v_org, v_s, 'accounts_payable', 'liability',
            'accounts_payable', 'IC-AP', 'Trade payables');
  INSERT INTO public.accounts (id, organization_id, business_id, code, name, account_type)
  VALUES (v_inc, v_org, v_p, 'IC-RV', 'Intercompany sales',     'income'),
         (v_exp, v_org, v_s, 'IC-CS', 'Intercompany purchases', 'expense');

  INSERT INTO public.contacts (id, organization_id, business_id, name)
  VALUES (v_c_sub, v_org, v_p, 'IC Sub Ltd (customer)'),
         (v_c_par, v_org, v_s, 'IC Parent Ltd (supplier)');

  -- Declarations in both directions.
  INSERT INTO public.consolidation_intercompany_partners
    (organization_id, group_id, business_id, contact_id, counterparty_business_id)
  VALUES (v_org, v_group, v_p, v_c_sub, v_s),
         (v_org, v_group, v_s, v_c_par, v_p);

  -- Parent invoices the subsidiary 40,000; the subsidiary books only 38,000.
  -- Entries are drafted, lined and then posted — a posted entry is immutable.
  INSERT INTO public.journal_entries
    (organization_id, business_id, entry_number, description, entry_date, status)
  VALUES (v_org, v_p, 'IC-JE-1', 'Intercompany sale', current_date, 'draft')
  RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines
    (organization_id, business_id, journal_entry_id, account_id, contact_id, debit, credit)
  VALUES (v_org, v_p, v_je, v_ar,  v_c_sub, 40000, 0),
         (v_org, v_p, v_je, v_inc, NULL,        0, 40000);
  UPDATE public.journal_entries SET status = 'posted' WHERE id = v_je;

  INSERT INTO public.journal_entries
    (organization_id, business_id, entry_number, description, entry_date, status)
  VALUES (v_org, v_s, 'IC-JE-2', 'Intercompany purchase', current_date, 'draft')
  RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines
    (organization_id, business_id, journal_entry_id, account_id, contact_id, debit, credit)
  VALUES (v_org, v_s, v_je, v_exp, NULL,    38000, 0),
         (v_org, v_s, v_je, v_ap,  v_c_par,     0, 38000);
  UPDATE public.journal_entries SET status = 'posted' WHERE id = v_je;


  -- 1. Exactly one reportable pair row, with both sides and the disagreement.
  SELECT * INTO v_r
    FROM public.consolidation_intercompany_balances(v_group, current_date - 1, current_date);
  IF v_r IS NULL THEN
    RAISE EXCEPTION 'the declared intercompany pair produced no row';
  END IF;
  IF v_r.declaring_business_id <> v_p OR v_r.counterparty_business_id <> v_s THEN
    RAISE EXCEPTION 'pair reported in the wrong direction';
  END IF;
  IF v_r.declaring_amount <> 40000 THEN
    RAISE EXCEPTION 'parent due-from expected 40000, got %', v_r.declaring_amount;
  END IF;
  IF v_r.counterparty_amount <> 38000 THEN
    RAISE EXCEPTION 'subsidiary due-to expected 38000, got %', v_r.counterparty_amount;
  END IF;
  IF v_r.difference <> 2000 THEN
    RAISE EXCEPTION 'the 2000 disagreement must be surfaced, got %', v_r.difference;
  END IF;
  IF (SELECT count(*) FROM public.consolidation_intercompany_balances(
        v_group, current_date - 1, current_date)) <> 1 THEN
    RAISE EXCEPTION 'a zero-position direction must not be reported as a row';
  END IF;

  -- 2. Declarations outside the effective window are not picked up.
  UPDATE public.consolidation_intercompany_partners
     SET effective_from = current_date + 30
   WHERE group_id = v_group AND business_id = v_p;
  IF EXISTS (SELECT 1 FROM public.consolidation_intercompany_balances(
               v_group, current_date - 1, current_date)
             WHERE declaring_business_id = v_p) THEN
    RAISE EXCEPTION 'a future-dated declaration must not affect the period';
  END IF;
  UPDATE public.consolidation_intercompany_partners
     SET effective_from = current_date - 365
   WHERE group_id = v_group AND business_id = v_p;

  -- 3. Guard: a company cannot be its own counterparty.
  BEGIN
    INSERT INTO public.consolidation_intercompany_partners
      (organization_id, group_id, business_id, contact_id, counterparty_business_id)
    VALUES (v_org, v_group, v_p, v_c_sub, v_p);
    RAISE EXCEPTION 'self-counterparty must be rejected';
  EXCEPTION WHEN others THEN
    IF SQLSTATE = 'P0001' AND SQLERRM LIKE 'self-counterparty%' THEN RAISE; END IF;
  END;

  -- 4. Guard: the contact must belong to the declaring company.
  BEGIN
    INSERT INTO public.consolidation_intercompany_partners
      (organization_id, group_id, business_id, contact_id, counterparty_business_id)
    VALUES (v_org, v_group, v_p, v_c_par, v_s);
    RAISE EXCEPTION 'a foreign contact must be rejected';
  EXCEPTION WHEN others THEN
    IF SQLSTATE = 'P0001' AND SQLERRM LIKE 'a foreign contact%' THEN RAISE; END IF;
  END;

  -- 5. Guard: overlapping declarations for the same contact are rejected.
  BEGIN
    INSERT INTO public.consolidation_intercompany_partners
      (organization_id, group_id, business_id, contact_id, counterparty_business_id)
    VALUES (v_org, v_group, v_p, v_c_sub, v_s);
    RAISE EXCEPTION 'an overlapping declaration must be rejected';
  EXCEPTION WHEN others THEN
    IF SQLSTATE = 'P0001' AND SQLERRM LIKE 'an overlapping declaration%' THEN RAISE; END IF;
  END;

  -- 6. Every declaration change is attributable in the consolidation audit log.
  IF (SELECT count(*) FROM public.consolidation_group_change_log
       WHERE group_id = v_group AND entity = 'intercompany_partner') < 3 THEN
    RAISE EXCEPTION 'declaration changes must be recorded in the change log';
  END IF;

  RAISE NOTICE 'Brick 6 intercompany behaviour: OK';
END $$;

ROLLBACK;

-- ---------------------------------------------------------------------------
-- Block 3 — the group-account projection, GL-only intercompany activity, the
-- unmapped refusal, the coverage worklist and cross-organization isolation.
--
-- Two members, two base currencies, two disjoint charts of accounts, one group
-- chart. Everything is created here and rolled back by the closing RAISE.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_org_b uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
  v_user_b uuid := gen_random_uuid();
  v_p uuid := gen_random_uuid();     -- parent, KES = presentation currency
  v_s uuid := gen_random_uuid();     -- subsidiary, USD, requires translation
  v_group uuid := gen_random_uuid();
  v_cta uuid;
  v_cash_p uuid; v_due_p uuid; v_cap_p uuid; v_rev_p uuid; v_exp_p uuid;
  v_cash_s uuid; v_due_s uuid; v_cap_s uuid; v_exp_s uuid;
  v_ga_cash uuid; v_ga_due uuid; v_ga_owed uuid;
  v_ga_cap uuid; v_ga_rev uuid; v_ga_exp uuid;
  v_c_sub uuid := gen_random_uuid();   -- contact in P that IS the subsidiary
  v_c_par uuid := gen_random_uuid();   -- contact in S that IS the parent
  v_c_ext uuid := gen_random_uuid();   -- genuine third party
  v_je uuid;
  v_from date := DATE '2026-03-01';
  v_to   date := DATE '2026-03-31';
  v_hist date := DATE '2026-02-10';
  v_close numeric;
  v_row record;
  v_rows integer;
  v_msg text;
  v_refused boolean;
BEGIN
  ------------------------------------------------------------------ fixture ---
  INSERT INTO auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  VALUES (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'consol-ic-' || replace(v_user::text,'-','') || '@example.test', now(), now()),
         (v_user_b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'consol-ic-' || replace(v_user_b::text,'-','') || '@example.test', now(), now());
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org,   'IC Org A', 'consol-ic-' || replace(v_org::text,'-','')),
         (v_org_b, 'IC Org B', 'consol-ic-' || replace(v_org_b::text,'-',''));
  INSERT INTO public.user_roles (user_id, organization_id, role, is_active)
  VALUES (v_user, v_org, 'owner', true), (v_user_b, v_org_b, 'owner', true);

  INSERT INTO public.businesses
    (id, organization_id, name, country, base_currency, fiscal_year_start, tax_id, registration_number)
  VALUES (v_p, v_org, 'IC Parent Ltd', 'KE', 'KES', 1, 'P051-TAX', 'PVT-P-01'),
         (v_s, v_org, 'IC Sub Inc',    'US', 'USD', 1, 'S099-TAX', 'PVT-S-02');

  -- One rate book, the platform's own, covering the fiscal year to date.
  INSERT INTO public.exchange_rates
    (organization_id, business_id, from_currency, to_currency, rate, effective_date, source, published_at)
  SELECT v_org, v_p, 'USD', 'KES',
         100 + (d::date - DATE '2026-01-01') * 0.10, d::date, 'manual', now()
    FROM generate_series(DATE '2025-12-01', DATE '2026-03-31', INTERVAL '1 day') d;

  -- Parent chart (numeric codes).
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_p, 'asset', 'cash_on_hand', '1000', 'Cash P') RETURNING id INTO v_cash_p;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_p, 'asset', 'other_current_asset', '1100', 'Due from group companies') RETURNING id INTO v_due_p;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_p, 'equity', 'common_stock', '3000', 'Share capital P') RETURNING id INTO v_cap_p;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_p, 'income', 'sales_income', '4000', 'Management fees P') RETURNING id INTO v_rev_p;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_p, 'expense', 'other_expense', '5000', 'Overheads P') RETURNING id INTO v_exp_p;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_p, 'equity', 'accumulated_other_comprehensive_income', '3900',
          'Foreign currency translation reserve') RETURNING id INTO v_cta;

  -- Subsidiary chart (alphanumeric codes; code matching cannot merge these).
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_s, 'asset', 'cash_on_hand', 'CB-01', 'Bank S') RETURNING id INTO v_cash_s;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_s, 'liability', 'other_current_liabilities', 'IC-01', 'Due to group companies') RETURNING id INTO v_due_s;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_s, 'equity', 'common_stock', 'EQ-01', 'Capital S') RETURNING id INTO v_cap_s;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_s, 'expense', 'other_expense', 'CS-01', 'Management fee charge S') RETURNING id INTO v_exp_s;

  -- Contacts: the intra-group pair carries the counterparty's legal tax id; the
  -- third party carries its own.
  INSERT INTO public.contacts (id, organization_id, business_id, name, type, tax_id)
  VALUES (v_c_sub, v_org, v_p, 'IC Sub Inc',     'customer', 'S099-TAX'),
         (v_c_par, v_org, v_s, 'IC Parent Ltd',  'supplier', 'P051-TAX'),
         (v_c_ext, v_org, v_p, 'Nairobi Stationers Ltd', 'supplier', 'X777-TAX');

  -- Parent: capitalisation, an intra-group management recharge booked straight
  -- to the GL (no invoice, so AR/AP would never see it), and a third-party bill.
  INSERT INTO public.journal_entries
    (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_p, 'IC3-P-1', v_from, 'Capitalisation', 'draft', 'KES', 1) RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines (organization_id, business_id, journal_entry_id, account_id, debit, credit)
  VALUES (v_org, v_p, v_je, v_cash_p, 200000, 0), (v_org, v_p, v_je, v_cap_p, 0, 200000);
  UPDATE public.journal_entries SET status = 'posted', posted_at = now() WHERE id = v_je;

  INSERT INTO public.journal_entries
    (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_p, 'IC3-P-2', DATE '2026-03-10', 'Management recharge to subsidiary', 'draft', 'KES', 1) RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines
    (organization_id, business_id, journal_entry_id, account_id, contact_id, debit, credit)
  VALUES (v_org, v_p, v_je, v_due_p, v_c_sub, 5000, 0),
         (v_org, v_p, v_je, v_rev_p, NULL,       0, 5000);
  UPDATE public.journal_entries SET status = 'posted', posted_at = now() WHERE id = v_je;

  INSERT INTO public.journal_entries
    (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_p, 'IC3-P-3', DATE '2026-03-12', 'Stationery', 'draft', 'KES', 1) RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines
    (organization_id, business_id, journal_entry_id, account_id, contact_id, debit, credit)
  VALUES (v_org, v_p, v_je, v_exp_p,  v_c_ext, 1200, 0),
         (v_org, v_p, v_je, v_cash_p, NULL,       0, 1200);
  UPDATE public.journal_entries SET status = 'posted', posted_at = now() WHERE id = v_je;

  -- Subsidiary: prior-period share issue (opening equity at the historical
  -- rate) and the other leg of the recharge, 400 USD.
  INSERT INTO public.journal_entries
    (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_s, 'IC3-S-1', v_hist, 'Share issue', 'draft', 'USD', 1) RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines (organization_id, business_id, journal_entry_id, account_id, debit, credit)
  VALUES (v_org, v_s, v_je, v_cash_s, 2000, 0), (v_org, v_s, v_je, v_cap_s, 0, 2000);
  UPDATE public.journal_entries SET status = 'posted', posted_at = now() WHERE id = v_je;

  INSERT INTO public.journal_entries
    (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_s, 'IC3-S-2', DATE '2026-03-10', 'Management fee from parent', 'draft', 'USD', 1) RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines
    (organization_id, business_id, journal_entry_id, account_id, contact_id, debit, credit)
  VALUES (v_org, v_s, v_je, v_exp_s, NULL,     400, 0),
         (v_org, v_s, v_je, v_due_s, v_c_par,    0, 400);
  UPDATE public.journal_entries SET status = 'posted', posted_at = now() WHERE id = v_je;

  INSERT INTO public.consolidation_groups
    (id, organization_id, name, parent_business_id, presentation_currency, cta_account_id)
  VALUES (v_group, v_org, 'IC Projection Group', v_p, 'KES', v_cta);
  INSERT INTO public.consolidation_group_members
    (organization_id, group_id, business_id, ownership_percent, method, effective_from)
  VALUES (v_org, v_group, v_p, 100, 'full', DATE '2026-01-01');
  INSERT INTO public.consolidation_group_members
    (organization_id, group_id, business_id, parent_business_id, ownership_percent, method,
     effective_from, historical_rate_date)
  VALUES (v_org, v_group, v_s, v_p, 100, 'full', DATE '2026-01-01', v_hist);

  -- One group chart for two disjoint member charts.
  INSERT INTO public.consolidation_group_accounts (organization_id, group_id, code, name, account_type, sort_order)
  VALUES (v_org, v_group, 'G-1000', 'Group cash and bank', 'asset', 10) RETURNING id INTO v_ga_cash;
  INSERT INTO public.consolidation_group_accounts (organization_id, group_id, code, name, account_type, sort_order)
  VALUES (v_org, v_group, 'G-1100', 'Group amounts due from members', 'asset', 20) RETURNING id INTO v_ga_due;
  INSERT INTO public.consolidation_group_accounts (organization_id, group_id, code, name, account_type, sort_order)
  VALUES (v_org, v_group, 'G-2100', 'Group amounts due to members', 'liability', 30) RETURNING id INTO v_ga_owed;
  INSERT INTO public.consolidation_group_accounts (organization_id, group_id, code, name, account_type, sort_order)
  VALUES (v_org, v_group, 'G-3000', 'Group share capital', 'equity', 40) RETURNING id INTO v_ga_cap;
  INSERT INTO public.consolidation_group_accounts (organization_id, group_id, code, name, account_type, sort_order)
  VALUES (v_org, v_group, 'G-4000', 'Group revenue', 'income', 50) RETURNING id INTO v_ga_rev;
  INSERT INTO public.consolidation_group_accounts (organization_id, group_id, code, name, account_type, sort_order)
  VALUES (v_org, v_group, 'G-5000', 'Group operating costs', 'expense', 60) RETURNING id INTO v_ga_exp;

  -- Every posted account is mapped EXCEPT the subsidiary's due-to account: the
  -- omission is what proves the refusal below.
  INSERT INTO public.consolidation_account_mappings
    (organization_id, group_id, business_id, account_id, group_account_id, effective_from)
  VALUES (v_org, v_group, v_p, v_cash_p, v_ga_cash, DATE '2026-01-01'),
         (v_org, v_group, v_p, v_due_p,  v_ga_due,  DATE '2026-01-01'),
         (v_org, v_group, v_p, v_cap_p,  v_ga_cap,  DATE '2026-01-01'),
         (v_org, v_group, v_p, v_rev_p,  v_ga_rev,  DATE '2026-01-01'),
         (v_org, v_group, v_p, v_exp_p,  v_ga_exp,  DATE '2026-01-01'),
         (v_org, v_group, v_s, v_cash_s, v_ga_cash, DATE '2026-01-01'),
         (v_org, v_group, v_s, v_cap_s,  v_ga_cap,  DATE '2026-01-01'),
         (v_org, v_group, v_s, v_exp_s,  v_ga_exp,  DATE '2026-01-01');

  -- Declarations in both directions; the third party is deliberately undeclared.
  INSERT INTO public.consolidation_intercompany_partners
    (organization_id, group_id, business_id, contact_id, counterparty_business_id, effective_from)
  VALUES (v_org, v_group, v_p, v_c_sub, v_s, DATE '2026-01-01'),
         (v_org, v_group, v_s, v_c_par, v_p, DATE '2026-01-01');

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);

  ------------------------------------------ 1: unmapped account is refused ----
  v_refused := false;
  BEGIN
    PERFORM count(*) FROM public.consolidation_intercompany_activity(v_group, v_from, v_to);
  EXCEPTION WHEN others THEN
    v_refused := true;
    v_msg := SQLERRM;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'intercompany activity was reported while an intercompany account had no group mapping';
  END IF;
  IF v_msg NOT LIKE '%IC-01%' THEN
    RAISE EXCEPTION 'the refusal does not name the unmapped intercompany account: %', v_msg;
  END IF;

  INSERT INTO public.consolidation_account_mappings
    (organization_id, group_id, business_id, account_id, group_account_id, effective_from)
  VALUES (v_org, v_group, v_s, v_due_s, v_ga_owed, DATE '2026-01-01');

  SELECT r.closing_rate INTO v_close
    FROM public.consolidation_member_translation_rates(v_group, v_s, v_from, v_to) r;
  IF v_close IS NULL OR v_close = 1 THEN
    RAISE EXCEPTION 'fixture is not discriminating: the subsidiary closing rate is %', v_close;
  END IF;

  --------------- 2: GL-only intercompany activity carries the group account ---
  SELECT * INTO v_row
    FROM public.consolidation_intercompany_activity(v_group, v_from, v_to) a
   WHERE a.declaring_business_id = v_p AND a.account_id = v_due_p;
  IF v_row IS NULL THEN
    RAISE EXCEPTION 'the parent''s GL-only intercompany recharge was not reported';
  END IF;
  IF v_row.counterparty_business_id <> v_s THEN
    RAISE EXCEPTION 'the recharge was attributed to the wrong counterparty';
  END IF;
  IF v_row.group_account_id <> v_ga_due OR v_row.group_account_code <> 'G-1100' THEN
    RAISE EXCEPTION 'the parent row carries group account % instead of G-1100', v_row.group_account_code;
  END IF;
  IF NOT v_row.is_mapped THEN
    RAISE EXCEPTION 'a mapped account was reported as unmapped';
  END IF;
  IF v_row.net_base <> 5000 OR v_row.net <> 5000 THEN
    RAISE EXCEPTION 'parent recharge expected 5000 base and 5000 presentation, got % / %',
      v_row.net_base, v_row.net;
  END IF;
  IF v_row.line_count <> 1 OR v_row.contact_count <> 1 THEN
    RAISE EXCEPTION 'parent recharge line/contact counts were % / %', v_row.line_count, v_row.contact_count;
  END IF;

  ----------- 3: the other side translates on the statements' own rate basis ---
  SELECT * INTO v_row
    FROM public.consolidation_intercompany_activity(v_group, v_from, v_to) a
   WHERE a.declaring_business_id = v_s AND a.account_id = v_due_s;
  IF v_row IS NULL THEN
    RAISE EXCEPTION 'the subsidiary''s side of the recharge was not reported';
  END IF;
  IF v_row.group_account_code <> 'G-2100' THEN
    RAISE EXCEPTION 'the subsidiary row carries group account % instead of G-2100', v_row.group_account_code;
  END IF;
  IF v_row.rate_class <> 'closing' THEN
    RAISE EXCEPTION 'a due-to balance was translated at the % rate', v_row.rate_class;
  END IF;
  IF v_row.rate_used <> v_close THEN
    RAISE EXCEPTION 'the intercompany row used rate % while the translated trial balance uses %',
      v_row.rate_used, v_close;
  END IF;
  IF v_row.net_base <> -400 THEN
    RAISE EXCEPTION 'the subsidiary due-to expected -400 USD, got %', v_row.net_base;
  END IF;
  IF v_row.net <> -round(400 * v_close, 2) THEN
    RAISE EXCEPTION 'the subsidiary due-to translated to % but the closing rate gives %',
      v_row.net, -round(400 * v_close, 2);
  END IF;

  -- Both sides stay visible as their own rows: nothing is netted into one figure.
  SELECT count(*) INTO v_rows
    FROM public.consolidation_intercompany_activity(v_group, v_from, v_to) a
   WHERE a.account_id IN (v_due_p, v_due_s);
  IF v_rows <> 2 THEN
    RAISE EXCEPTION 'expected both intercompany positions as separate rows, got %', v_rows;
  END IF;

  -- The figure is a projection of the statement line it belongs to: the group
  -- account reported here must be the one the translated trial balance reports.
  IF NOT EXISTS (
    SELECT 1 FROM public.get_consolidated_trial_balance_translated(v_group, v_from, v_to) t
     WHERE t.business_id = v_s AND t.account_id = v_due_s
       AND t.group_account_id = v_ga_owed AND t.rate_used = v_close
  ) THEN
    RAISE EXCEPTION 'the intercompany row and the translated trial balance disagree on the group account or rate';
  END IF;

  --------------------------------- 4: the coverage worklist tells the truth ---
  IF EXISTS (
    SELECT 1 FROM public.consolidation_intercompany_coverage(v_group, v_from, v_to) c
     WHERE c.contact_id IN (v_c_sub, v_c_par)
  ) THEN
    RAISE EXCEPTION 'a declared counterparty still appears on the coverage worklist';
  END IF;

  SELECT * INTO v_row
    FROM public.consolidation_intercompany_coverage(v_group, v_from, v_to) c
   WHERE c.contact_id = v_c_ext;
  IF v_row IS NULL THEN
    RAISE EXCEPTION 'ledger activity against an undeclared contact was not surfaced';
  END IF;
  IF v_row.suggested_counterparty_business_id IS NOT NULL THEN
    RAISE EXCEPTION 'a genuine third party was suggested as the member %',
      v_row.suggested_counterparty_business_name;
  END IF;
  IF v_row.gl_line_count <> 1 OR v_row.gl_net_base <> 1200 THEN
    RAISE EXCEPTION 'third-party activity reported % lines / net %', v_row.gl_line_count, v_row.gl_net_base;
  END IF;

  -- End the parent's declaration: the pair reappears on the worklist, and it is
  -- suggested only because the contact carries the subsidiary's legal tax id.
  UPDATE public.consolidation_intercompany_partners
     SET effective_to = DATE '2026-02-28'
   WHERE group_id = v_group AND business_id = v_p AND contact_id = v_c_sub;

  SELECT * INTO v_row
    FROM public.consolidation_intercompany_coverage(v_group, v_from, v_to) c
   WHERE c.contact_id = v_c_sub;
  IF v_row IS NULL THEN
    RAISE EXCEPTION 'an expired declaration left its activity unreported';
  END IF;
  IF v_row.suggested_counterparty_business_id <> v_s OR v_row.suggestion_basis <> 'tax_id' THEN
    RAISE EXCEPTION 'the member suggestion was % on basis % instead of the subsidiary on tax_id',
      v_row.suggested_counterparty_business_name, v_row.suggestion_basis;
  END IF;

  -- Identity, never resemblance: strip the legal identifier and the name alone
  -- must not produce a suggestion.
  UPDATE public.contacts SET tax_id = NULL WHERE id = v_c_sub;
  SELECT * INTO v_row
    FROM public.consolidation_intercompany_coverage(v_group, v_from, v_to) c
   WHERE c.contact_id = v_c_sub;
  IF v_row.suggested_counterparty_business_id IS NOT NULL THEN
    RAISE EXCEPTION 'a name match produced a counterparty suggestion';
  END IF;

  UPDATE public.contacts SET tax_id = 'S099-TAX' WHERE id = v_c_sub;
  UPDATE public.consolidation_intercompany_partners
     SET effective_to = NULL
   WHERE group_id = v_group AND business_id = v_p AND contact_id = v_c_sub;
  IF EXISTS (
    SELECT 1 FROM public.consolidation_intercompany_coverage(v_group, v_from, v_to) c
     WHERE c.contact_id = v_c_sub
  ) THEN
    RAISE EXCEPTION 'declaring the relationship did not clear it from the worklist';
  END IF;

  ------------------------------------- 5: another organization sees nothing ---
  -- Row-level security only bites for a non-privileged role, so the isolation
  -- assertions below run as `authenticated`, exactly as the application does.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user_b::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  IF (SELECT count(*) FROM public.consolidation_intercompany_partners
       WHERE group_id = v_group) <> 0 THEN
    RAISE EXCEPTION 'a foreign organization read this group''s intercompany declarations';
  END IF;
  v_refused := false;
  BEGIN
    PERFORM count(*) FROM public.consolidation_intercompany_coverage(v_group, v_from, v_to);
  EXCEPTION WHEN others THEN v_refused := (SQLSTATE = '42501'); END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'a foreign organization ran the coverage worklist for this group';
  END IF;
  v_refused := false;
  BEGIN
    PERFORM count(*) FROM public.consolidation_intercompany_activity(v_group, v_from, v_to);
  EXCEPTION WHEN others THEN v_refused := (SQLSTATE = '42501'); END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'a foreign organization ran the intercompany activity report for this group';
  END IF;

  -- The owner is not over-blocked by the isolation above: still as
  -- `authenticated`, only the claims change.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);
  IF (SELECT count(*) FROM public.consolidation_intercompany_partners
       WHERE group_id = v_group) <> 2 THEN
    RAISE EXCEPTION 'the owning user cannot read its own two intercompany declarations';
  END IF;
  IF (SELECT count(*) FROM public.consolidation_intercompany_activity(v_group, v_from, v_to)) < 2 THEN
    RAISE EXCEPTION 'the owning user lost access to its own intercompany activity';
  END IF;
  EXECUTE 'RESET ROLE';

  RAISE EXCEPTION 'rollback: Brick 6 projection, coverage and isolation invariants passed (closing rate %)', v_close;
END $$;

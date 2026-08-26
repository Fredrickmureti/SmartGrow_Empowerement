-- Consolidated trial balance: arithmetic reconciliation against member ledgers.
--
-- The foundation test proves the group configuration cannot be shaped into an
-- illegal structure. This test proves the resulting numbers are the ledger's
-- numbers: a group of two same-currency companies must report exactly the sum
-- of what each company reports on its own, and must still balance.
--
-- Self-contained: seeds its own organization, companies, accounts and posted
-- entries, then rolls the whole fixture back. Run it against a live database
-- with a session that may write to auth.users and public tables.

DO $$
DECLARE
  v_org   uuid := gen_random_uuid();
  v_user  uuid := gen_random_uuid();
  v_a     uuid := gen_random_uuid();   -- parent company
  v_b     uuid := gen_random_uuid();   -- 80%-owned subsidiary
  v_group uuid := gen_random_uuid();
  v_cash_a uuid; v_rev_a uuid; v_cash_b uuid; v_rev_b uuid;
  v_je_a uuid; v_je_b uuid;
  v_rows int;
  v_grp_dr numeric; v_grp_cr numeric;
  v_a_dr numeric; v_a_cr numeric; v_b_dr numeric; v_b_cr numeric;
  v_blocked boolean;
BEGIN
  ---------------------------------------------------------------- fixture ----
  INSERT INTO auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  VALUES (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'consol-tb-' || replace(v_user::text, '-', '') || '@example.test', now(), now());

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Consolidation TB Org', 'consol-tb-' || replace(v_org::text, '-', ''));

  INSERT INTO public.user_roles (user_id, organization_id, role, is_active)
  VALUES (v_user, v_org, 'owner', true);

  INSERT INTO public.businesses (id, organization_id, name, country, base_currency, fiscal_year_start)
  VALUES (v_a, v_org, 'TB Parent Ltd', 'KE', 'KES', 1),
         (v_b, v_org, 'TB Sub Ltd',    'KE', 'KES', 1);

  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_a, 'asset',  'cash_on_hand', '1000', 'Cash A')    RETURNING id INTO v_cash_a;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_a, 'income', 'sales_income', '4000', 'Revenue A') RETURNING id INTO v_rev_a;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_b, 'asset',  'cash_on_hand', '1000', 'Cash B')    RETURNING id INTO v_cash_b;
  INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name)
  VALUES (v_org, v_b, 'income', 'sales_income', '4000', 'Revenue B') RETURNING id INTO v_rev_b;

  -- Entries are drafted, lined, then posted: a posted entry is immutable, so
  -- lines can never be attached after the fact.
  INSERT INTO public.journal_entries
    (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_a, 'TB-A-1', DATE '2026-03-15', 'Parent sale', 'draft', 'KES', 1)
  RETURNING id INTO v_je_a;
  INSERT INTO public.journal_entry_lines
    (organization_id, business_id, journal_entry_id, account_id, debit, credit)
  VALUES (v_org, v_a, v_je_a, v_cash_a, 1000, 0),
         (v_org, v_a, v_je_a, v_rev_a,     0, 1000);
  UPDATE public.journal_entries SET status = 'posted', posted_at = now() WHERE id = v_je_a;

  INSERT INTO public.journal_entries
    (organization_id, business_id, entry_number, entry_date, description, status, currency, exchange_rate)
  VALUES (v_org, v_b, 'TB-B-1', DATE '2026-03-20', 'Sub sale', 'draft', 'KES', 1)
  RETURNING id INTO v_je_b;
  INSERT INTO public.journal_entry_lines
    (organization_id, business_id, journal_entry_id, account_id, debit, credit)
  VALUES (v_org, v_b, v_je_b, v_cash_b, 400, 0),
         (v_org, v_b, v_je_b, v_rev_b,    0, 400);
  UPDATE public.journal_entries SET status = 'posted', posted_at = now() WHERE id = v_je_b;

  INSERT INTO public.consolidation_groups
    (id, organization_id, name, parent_business_id, presentation_currency)
  VALUES (v_group, v_org, 'TB Group', v_a, 'KES');
  INSERT INTO public.consolidation_group_members
    (organization_id, group_id, business_id, ownership_percent, method, effective_from)
  VALUES (v_org, v_group, v_a, 100, 'full', DATE '2026-01-01');
  INSERT INTO public.consolidation_group_members
    (organization_id, group_id, business_id, parent_business_id, ownership_percent, method, effective_from)
  VALUES (v_org, v_group, v_b, v_a, 80, 'full', DATE '2026-01-01');

  ------------------------------------------------------------ reconcile ------
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT count(*), COALESCE(sum(total_debit), 0), COALESCE(sum(total_credit), 0)
    INTO v_rows, v_grp_dr, v_grp_cr
    FROM public.get_consolidated_trial_balance(v_group, DATE '2026-01-01', DATE '2026-12-31');

  SELECT COALESCE(sum(total_debit), 0), COALESCE(sum(total_credit), 0) INTO v_a_dr, v_a_cr
    FROM public.get_account_movements(v_org, DATE '2026-01-01', DATE '2026-12-31', v_a, NULL);
  SELECT COALESCE(sum(total_debit), 0), COALESCE(sum(total_credit), 0) INTO v_b_dr, v_b_cr
    FROM public.get_account_movements(v_org, DATE '2026-01-01', DATE '2026-12-31', v_b, NULL);

  RESET ROLE;

  IF v_rows <> 4 THEN
    RAISE EXCEPTION 'the group reported % account rows, but the two companies posted to 4', v_rows;
  END IF;
  IF v_grp_dr <> v_a_dr + v_b_dr OR v_grp_cr <> v_a_cr + v_b_cr THEN
    RAISE EXCEPTION 'group totals (dr % / cr %) do not equal the members (dr % + % / cr % + %)',
      v_grp_dr, v_grp_cr, v_a_dr, v_b_dr, v_a_cr, v_b_cr;
  END IF;
  IF v_grp_dr <> v_grp_cr THEN
    RAISE EXCEPTION 'the consolidated trial balance does not balance: dr % vs cr %', v_grp_dr, v_grp_cr;
  END IF;
  -- Full consolidation aggregates 100% of a controlled subsidiary; the 20% not
  -- owned is a non-controlling interest in equity, never a haircut on the lines.
  IF v_grp_dr <> 1400 THEN
    RAISE EXCEPTION 'expected the full 1000 + 400 to consolidate, got %', v_grp_dr;
  END IF;

  ---------------------------------------------------------------- refusals ---
  -- A period that ends before it starts is not a reporting window.
  v_blocked := false;
  BEGIN
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);
    PERFORM * FROM public.get_consolidated_trial_balance(v_group, DATE '2026-12-31', DATE '2026-01-01');
  EXCEPTION WHEN others THEN v_blocked := true; END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'a reporting period ending before it starts was accepted';
  END IF;

  -- An unknown group is not an empty group.
  v_blocked := false;
  BEGIN
    PERFORM * FROM public.get_consolidated_trial_balance(gen_random_uuid(), DATE '2026-01-01', DATE '2026-12-31');
  EXCEPTION WHEN others THEN v_blocked := true; END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'a trial balance was produced for a group that does not exist';
  END IF;

  RAISE EXCEPTION 'rollback: consolidated trial balance reconciliation passed (dr % = % + %)',
    v_grp_dr, v_a_dr, v_b_dr;
END $$;

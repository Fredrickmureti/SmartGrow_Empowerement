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

-- Aged Payables — point-in-time engine scenario fixtures (Phase 5.2).
--
-- WHAT THIS PROVES
-- `finance_ap_open_items_as_of` is the single payables engine. A payables
-- figure is only trustworthy if it is a function of (org, business, branch,
-- as-of date) and NOTHING else — not the server clock, not `bills.status`,
-- not `bills.amount_paid`. This file drives ten accounting scenarios (A–J)
-- through the engine and asserts the exact expected number for each, then
-- proves the three consumer surfaces agree on one dataset.
--
-- SAFETY
-- Every behavioural block seeds its OWN isolated organization and rolls back:
-- the closing `RAISE EXCEPTION 'rollback: ...'` aborts the transaction, so no
-- financial row is ever left behind in a live schema. `session_replication_role
-- = replica` is set inside that same doomed transaction so document-workflow
-- triggers (approval gates, automation outbox, GL integrity) do not run — this
-- file tests the READ engine, and the fixture writes are the arrange step, not
-- the subject.

-- ---------------------------------------------------------------------------
-- 1) Contract: exactly one engine, defined once.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_count int;
BEGIN
  FOR v_count IN
    SELECT count(*)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('finance_ap_open_items_as_of','finance_ap_vendor_credit_as_of',
                         'get_ap_aging_summary','get_ap_summary','finance_ap_aging_reconciliation')
     GROUP BY p.proname
  LOOP
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'an AP aging function has % overloads — there must be exactly one', v_count;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2) Contract: the engine is hardened (definer + pinned search_path + org guard)
--    and not executable anonymously.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.prosrc, p.proacl
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('finance_ap_open_items_as_of','finance_ap_vendor_credit_as_of',
                         'get_ap_aging_summary','get_ap_summary','finance_ap_aging_reconciliation')
  LOOP
    IF NOT r.prosecdef THEN
      RAISE EXCEPTION '% is not SECURITY DEFINER', r.proname;
    END IF;
    IF NOT (COALESCE(array_to_string(r.proconfig, ','), '') ~ 'search_path=') THEN
      RAISE EXCEPTION '% has no pinned search_path', r.proname;
    END IF;
    IF r.prosrc !~ 'finance_can_read_org' THEN
      RAISE EXCEPTION '% has no organization membership check', r.proname;
    END IF;
    IF has_function_privilege('anon', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is executable by anon — payables data would be public', r.proname;
    END IF;
    IF NOT has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is not executable by authenticated — the app cannot read payables', r.proname;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3) Contract: consumers hold no private aging arithmetic. Buckets come from
--    `finance_aging_bucket`, residuals from the engine — never from
--    `bills.status` / `bills.amount_paid`.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_src text; v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['get_ap_aging_summary','get_ap_summary'] LOOP
    SELECT p.prosrc INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_src !~ 'finance_ap_open_items_as_of' THEN
      RAISE EXCEPTION '% does not read the point-in-time engine', v_name;
    END IF;
  END LOOP;

  -- The aging report itself must never touch document settlement columns:
  -- residuals belong to the engine. (`get_ap_summary` may read `amount_paid`
  -- only to size UNPOSTED documents, which by definition have no GL residual.)
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_ap_aging_summary';
  IF v_src ~* 'amount_paid' THEN
    RAISE EXCEPTION 'get_ap_aging_summary derives payables from bills.amount_paid instead of the engine residual';
  END IF;

END $$;

-- ---------------------------------------------------------------------------
-- 4) Behavioural: scenarios A–J against an isolated seeded organization.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_biz uuid := gen_random_uuid();
  v_branch uuid := gen_random_uuid();
  v_branch2 uuid := gen_random_uuid();
  v_vendor uuid := gen_random_uuid();
  v_ap uuid := gen_random_uuid();
  v_exp uuid := gen_random_uuid();
  v_as_of date := DATE '2026-06-30';
  v_bill_a uuid := gen_random_uuid();   -- not due
  v_bill_b uuid := gen_random_uuid();   -- overdue 45 days
  v_bill_c uuid := gen_random_uuid();   -- partial payment
  v_bill_d uuid := gen_random_uuid();   -- multi payment
  v_bill_e1 uuid := gen_random_uuid();  -- one payment across two bills
  v_bill_e2 uuid := gen_random_uuid();
  v_bill_f uuid := gen_random_uuid();   -- vendor credit applied
  v_bill_g uuid := gen_random_uuid();   -- reversed (voided) payment
  v_bill_i uuid := gen_random_uuid();   -- foreign currency
  v_bill_j uuid := gen_random_uuid();   -- other branch
  v_pay uuid;
  v_vcn uuid := gen_random_uuid();
  v_actual numeric;
  v_bucket text;
  v_summary jsonb;
  v_total numeric;
BEGIN
  PERFORM set_config('session_replication_role', 'replica', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'AP Aging Fixture', 'ap-aging-fixture-' || replace(v_org::text, '-', ''));

  INSERT INTO public.businesses (id, organization_id, name, country, base_currency)
  VALUES (v_biz, v_org, 'Fixture Co', 'KE', 'USD');

  INSERT INTO public.branches (id, organization_id, business_id, name)
  VALUES (v_branch, v_org, v_biz, 'Main'), (v_branch2, v_org, v_biz, 'Second');

  INSERT INTO public.contacts (id, organization_id, business_id, name)
  VALUES (v_vendor, v_org, v_biz, 'Fixture Vendor');

  INSERT INTO public.accounts (id, organization_id, business_id, code, name, account_type, system_role)
  VALUES (v_ap, v_org, v_biz, '2000', 'Accounts Payable', 'liability', 'accounts_payable');
  INSERT INTO public.accounts (id, organization_id, business_id, code, name, account_type)
  VALUES (v_exp, v_org, v_biz, '5000', 'Purchases', 'expense');

  -- Bills. Each becomes visible to the engine only through a POSTED journal
  -- entry on the AP control account (source_type = 'bill'), never by existing.
  INSERT INTO public.bills (id, organization_id, business_id, branch_id, vendor_id, bill_number,
                            bill_date, due_date, subtotal, total, status, currency, currency_rate)
  VALUES
    (v_bill_a,  v_org, v_biz, v_branch,  v_vendor, 'B-A',  v_as_of - 10, v_as_of + 20, 1000, 1000, 'received', 'USD', 1),
    (v_bill_b,  v_org, v_biz, v_branch,  v_vendor, 'B-B',  v_as_of - 60, v_as_of - 45,  500,  500, 'received', 'USD', 1),
    (v_bill_c,  v_org, v_biz, v_branch,  v_vendor, 'B-C',  v_as_of - 40, v_as_of - 10, 1000, 1000, 'received', 'USD', 1),
    (v_bill_d,  v_org, v_biz, v_branch,  v_vendor, 'B-D',  v_as_of - 40, v_as_of - 5,  1000, 1000, 'received', 'USD', 1),
    (v_bill_e1, v_org, v_biz, v_branch,  v_vendor, 'B-E1', v_as_of - 30, v_as_of - 5,   400,  400, 'received', 'USD', 1),
    (v_bill_e2, v_org, v_biz, v_branch,  v_vendor, 'B-E2', v_as_of - 30, v_as_of - 5,   600,  600, 'received', 'USD', 1),
    (v_bill_f,  v_org, v_biz, v_branch,  v_vendor, 'B-F',  v_as_of - 20, v_as_of - 1,   800,  800, 'received', 'USD', 1),
    (v_bill_g,  v_org, v_biz, v_branch,  v_vendor, 'B-G',  v_as_of - 20, v_as_of - 1,   700,  700, 'received', 'USD', 1),
    (v_bill_i,  v_org, v_biz, v_branch,  v_vendor, 'B-I',  v_as_of - 20, v_as_of - 1,   100,  100, 'received', 'EUR', 1.10),
    (v_bill_j,  v_org, v_biz, v_branch2, v_vendor, 'B-J',  v_as_of - 20, v_as_of - 1,   900,  900, 'received', 'USD', 1);

  INSERT INTO public.journal_entries (id, organization_id, business_id, branch_id, entry_number,
                                      entry_date, description, status, source_type, source_id)
  SELECT gen_random_uuid(), v_org, v_biz, b.branch_id, 'JE-' || b.bill_number,
         b.bill_date, 'bill posting', 'posted', 'bill', b.id
    FROM public.bills b WHERE b.organization_id = v_org;

  INSERT INTO public.journal_entry_lines (id, journal_entry_id, organization_id, business_id, branch_id,
                                          account_id, contact_id, debit, credit)
  SELECT gen_random_uuid(), je.id, v_org, v_biz, je.branch_id, v_ap, v_vendor, 0,
         (SELECT b.total * COALESCE(NULLIF(b.currency_rate,0),1) FROM public.bills b WHERE b.id = je.source_id)
    FROM public.journal_entries je WHERE je.organization_id = v_org;

  -- C: one partial payment of 400 five days before the as-of date.
  v_pay := gen_random_uuid();
  INSERT INTO public.bill_payments (id, organization_id, business_id, branch_id, payment_date, amount, status)
  VALUES (v_pay, v_org, v_biz, v_branch, v_as_of - 5, 400, 'completed');
  INSERT INTO public.bill_payment_allocations (id, bill_payment_id, bill_id, amount, organization_id, business_id, branch_id)
  VALUES (gen_random_uuid(), v_pay, v_bill_c, 400, v_org, v_biz, v_branch);

  -- D: two payments on the same bill.
  v_pay := gen_random_uuid();
  INSERT INTO public.bill_payments (id, organization_id, business_id, branch_id, payment_date, amount, status)
  VALUES (v_pay, v_org, v_biz, v_branch, v_as_of - 20, 300, 'completed');
  INSERT INTO public.bill_payment_allocations (id, bill_payment_id, bill_id, amount, organization_id, business_id, branch_id)
  VALUES (gen_random_uuid(), v_pay, v_bill_d, 300, v_org, v_biz, v_branch);
  v_pay := gen_random_uuid();
  INSERT INTO public.bill_payments (id, organization_id, business_id, branch_id, payment_date, amount, status)
  VALUES (v_pay, v_org, v_biz, v_branch, v_as_of - 3, 200, 'completed');
  INSERT INTO public.bill_payment_allocations (id, bill_payment_id, bill_id, amount, organization_id, business_id, branch_id)
  VALUES (gen_random_uuid(), v_pay, v_bill_d, 200, v_org, v_biz, v_branch);

  -- E: ONE payment settling two bills (200 + 300).
  v_pay := gen_random_uuid();
  INSERT INTO public.bill_payments (id, organization_id, business_id, branch_id, payment_date, amount, status)
  VALUES (v_pay, v_org, v_biz, v_branch, v_as_of - 2, 500, 'completed');
  INSERT INTO public.bill_payment_allocations (id, bill_payment_id, bill_id, amount, organization_id, business_id, branch_id)
  VALUES (gen_random_uuid(), v_pay, v_bill_e1, 200, v_org, v_biz, v_branch),
         (gen_random_uuid(), v_pay, v_bill_e2, 300, v_org, v_biz, v_branch);

  -- G: a payment that was reversed — it must not reduce the payable.
  v_pay := gen_random_uuid();
  INSERT INTO public.bill_payments (id, organization_id, business_id, branch_id, payment_date, amount, status, voided_at)
  VALUES (v_pay, v_org, v_biz, v_branch, v_as_of - 6, 700, 'voided', (v_as_of - 4)::timestamptz);
  INSERT INTO public.bill_payment_allocations (id, bill_payment_id, bill_id, amount, organization_id, business_id, branch_id)
  VALUES (gen_random_uuid(), v_pay, v_bill_g, 700, v_org, v_biz, v_branch);

  -- F: a vendor credit note of 500, 300 of it applied to bill F.
  INSERT INTO public.vendor_credit_notes (id, organization_id, business_id, branch_id, vendor_id,
                                          credit_note_number, credit_date, status, total, currency)
  VALUES (v_vcn, v_org, v_biz, v_branch, v_vendor, 'VCN-1', v_as_of - 15, 'issued', 500, 'USD');
  INSERT INTO public.vendor_credit_note_applications (id, credit_note_id, bill_id, amount, organization_id, business_id, applied_at)
  VALUES (gen_random_uuid(), v_vcn, v_bill_f, 300, v_org, v_biz, (v_as_of - 10)::timestamptz);

  -- ===== A: not yet due =====
  SELECT residual_amount, aging_bucket INTO v_actual, v_bucket
    FROM public.finance_ap_open_items_as_of(v_org, v_biz, NULL, v_as_of) WHERE document_id = v_bill_a;
  IF v_actual <> 1000 OR v_bucket <> 'not_due' THEN
    RAISE EXCEPTION 'A: expected 1000/not_due, got %/%', v_actual, v_bucket;
  END IF;

  -- ===== B: 45 days overdue lands in 31–60 =====
  SELECT residual_amount, aging_bucket INTO v_actual, v_bucket
    FROM public.finance_ap_open_items_as_of(v_org, v_biz, NULL, v_as_of) WHERE document_id = v_bill_b;
  IF v_actual <> 500 OR v_bucket <> 'days30' THEN
    RAISE EXCEPTION 'B: expected 500/days30, got %/%', v_actual, v_bucket;
  END IF;

  -- ===== C: partial payment =====
  SELECT residual_amount INTO v_actual
    FROM public.finance_ap_open_items_as_of(v_org, v_biz, NULL, v_as_of) WHERE document_id = v_bill_c;
  IF v_actual <> 600 THEN RAISE EXCEPTION 'C: expected 600, got %', v_actual; END IF;

  -- ===== D: multiple payments =====
  SELECT residual_amount INTO v_actual
    FROM public.finance_ap_open_items_as_of(v_org, v_biz, NULL, v_as_of) WHERE document_id = v_bill_d;
  IF v_actual <> 500 THEN RAISE EXCEPTION 'D: expected 500, got %', v_actual; END IF;

  -- ===== E: one payment spanning two bills =====
  SELECT COALESCE(SUM(residual_amount), 0) INTO v_actual
    FROM public.finance_ap_open_items_as_of(v_org, v_biz, NULL, v_as_of)
   WHERE document_id IN (v_bill_e1, v_bill_e2);
  IF v_actual <> 500 THEN RAISE EXCEPTION 'E: expected 500 across both bills, got %', v_actual; END IF;

  -- ===== F: applied vendor credit reduces the bill; the rest stays as credit =====
  SELECT residual_amount INTO v_actual
    FROM public.finance_ap_open_items_as_of(v_org, v_biz, NULL, v_as_of) WHERE document_id = v_bill_f;
  IF v_actual <> 500 THEN RAISE EXCEPTION 'F: expected 500 after credit, got %', v_actual; END IF;
  SELECT COALESCE(SUM(credit_amount), 0) INTO v_actual
    FROM public.finance_ap_vendor_credit_as_of(v_org, v_biz, NULL, v_as_of);
  IF v_actual <> 200 THEN RAISE EXCEPTION 'F: expected 200 unapplied credit, got %', v_actual; END IF;

  -- ===== G: a reversed payment never settles anything =====
  SELECT residual_amount INTO v_actual
    FROM public.finance_ap_open_items_as_of(v_org, v_biz, NULL, v_as_of) WHERE document_id = v_bill_g;
  IF v_actual <> 700 THEN RAISE EXCEPTION 'G: reversed payment still reduced the payable (got %)', v_actual; END IF;

  -- ===== H: history is immutable — as of the day before the payment, bill C is whole =====
  SELECT residual_amount INTO v_actual
    FROM public.finance_ap_open_items_as_of(v_org, v_biz, NULL, v_as_of - 6) WHERE document_id = v_bill_c;
  IF v_actual <> 1000 THEN
    RAISE EXCEPTION 'H: historical re-run leaked a later payment — expected 1000, got %', v_actual;
  END IF;
  -- ...and the vendor credit did not exist before its credit date.
  SELECT COALESCE(SUM(credit_amount), 0) INTO v_actual
    FROM public.finance_ap_vendor_credit_as_of(v_org, v_biz, NULL, v_as_of - 20);
  IF v_actual <> 0 THEN RAISE EXCEPTION 'H: credit note surfaced before its credit date (%)', v_actual; END IF;

  -- ===== I: foreign currency is aggregated in base currency only =====
  SELECT residual_amount, base_residual_amount INTO v_actual, v_total
    FROM public.finance_ap_open_items_as_of(v_org, v_biz, NULL, v_as_of) WHERE document_id = v_bill_i;
  IF v_actual <> 100 OR v_total <> 110 THEN
    RAISE EXCEPTION 'I: expected 100 EUR / 110 base, got % / %', v_actual, v_total;
  END IF;

  -- ===== J: branch scope isolates the second branch =====
  IF EXISTS (SELECT 1 FROM public.finance_ap_open_items_as_of(v_org, v_biz, v_branch, v_as_of)
              WHERE document_id = v_bill_j) THEN
    RAISE EXCEPTION 'J: a second-branch bill leaked into a branch-scoped report';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.finance_ap_open_items_as_of(v_org, v_biz, v_branch2, v_as_of)
                  WHERE document_id = v_bill_j) THEN
    RAISE EXCEPTION 'J: the second-branch bill is missing from its own branch report';
  END IF;

  -- ===== Phase 5.3: cross-surface equality on one dataset =====
  -- Gross exposure straight from the engine; every consumer must reproduce it
  -- net of the 200 of unapplied vendor credit.
  SELECT COALESCE(SUM(base_residual_amount), 0) INTO v_total
    FROM public.finance_ap_open_items_as_of(v_org, v_biz, NULL, v_as_of);

  SELECT s.total_residual INTO v_actual
    FROM public.get_ap_summary(v_org, v_biz, NULL, v_as_of) s;
  IF abs(COALESCE(v_actual, -1) - (v_total - 200)) > 0.05 THEN
    RAISE EXCEPTION 'AP KPI total % disagrees with the engine net of credit %', v_actual, v_total - 200;
  END IF;

  SELECT ((public.get_ap_aging_summary(v_org, v_biz, NULL, v_as_of) -> 'totals') ->> 'total')::numeric
    INTO v_actual;
  IF abs(COALESCE(v_actual, -1) - (v_total - 200)) > 0.05 THEN
    RAISE EXCEPTION 'Aged Payables total % disagrees with the engine net of credit %',
      v_actual, v_total - 200;
  END IF;

  -- The reconciliation surface reports the SAME net aging figure (its GL side
  -- is deliberately not asserted here: this fixture seeds bill postings only,
  -- so settlement journals are absent by design).
  SELECT r.aging_total INTO v_actual
    FROM public.finance_ap_aging_reconciliation(v_org, v_biz, NULL, v_as_of) r;
  IF abs(COALESCE(v_actual, -1) - (v_total - 200)) > 0.05 THEN
    RAISE EXCEPTION 'Reconciliation aging total % disagrees with the engine net of credit %',
      v_actual, v_total - 200;
  END IF;



  RAISE NOTICE 'AP aging as-of scenarios A–J and cross-surface equality hold (engine gross %)', v_total;
  RAISE EXCEPTION 'rollback: behavioural block complete';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'rollback: behavioural block complete' THEN
    RAISE;
  END IF;
END $$;

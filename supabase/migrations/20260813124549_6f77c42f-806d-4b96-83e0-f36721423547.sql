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
  v_bill_a uuid := gen_random_uuid();
  v_bill_b uuid := gen_random_uuid();
  v_bill_c uuid := gen_random_uuid();
  v_bill_d uuid := gen_random_uuid();
  v_bill_e1 uuid := gen_random_uuid();
  v_bill_e2 uuid := gen_random_uuid();
  v_bill_f uuid := gen_random_uuid();
  v_bill_g uuid := gen_random_uuid();
  v_bill_i uuid := gen_random_uuid();
  v_bill_j uuid := gen_random_uuid();
  v_pay uuid;
  v_vcn uuid := gen_random_uuid();
  v_actual numeric;
  v_bucket text;
  v_total numeric;
  v_tbl text;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  FOREACH v_tbl IN ARRAY ARRAY['organizations','businesses','branches','contacts','accounts','bills',
                               'journal_entries','journal_entry_lines','bill_payments',
                               'bill_payment_allocations','vendor_credit_notes',
                               'vendor_credit_note_applications'] LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER USER', v_tbl);
  END LOOP;

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

  v_pay := gen_random_uuid();
  INSERT INTO public.bill_payments (id, organization_id, business_id, branch_id, payment_date, amount, status)
  VALUES (v_pay, v_org, v_biz, v_branch, v_as_of - 5, 400, 'completed');
  INSERT INTO public.bill_payment_allocations (id, bill_payment_id, bill_id, amount, organization_id, business_id, branch_id)
  VALUES (gen_random_uuid(), v_pay, v_bill_c, 400, v_org, v_biz, v_branch);

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

  v_pay := gen_random_uuid();
  INSERT INTO public.bill_payments (id, organization_id, business_id, branch_id, payment_date, amount, status)
  VALUES (v_pay, v_org, v_biz, v_branch, v_as_of - 2, 500, 'completed');
  INSERT INTO public.bill_payment_allocations (id, bill_payment_id, bill_id, amount, organization_id, business_id, branch_id)
  VALUES (gen_random_uuid(), v_pay, v_bill_e1, 200, v_org, v_biz, v_branch),
         (gen_random_uuid(), v_pay, v_bill_e2, 300, v_org, v_biz, v_branch);

  v_pay := gen_random_uuid();
  INSERT INTO public.bill_payments (id, organization_id, business_id, branch_id, payment_date, amount, status, voided_at)
  VALUES (v_pay, v_org, v_biz, v_branch, v_as_of - 6, 700, 'voided', (v_as_of - 4)::timestamptz);
  INSERT INTO public.bill_payment_allocations (id, bill_payment_id, bill_id, amount, organization_id, business_id, branch_id)
  VALUES (gen_random_uuid(), v_pay, v_bill_g, 700, v_org, v_biz, v_branch);

  INSERT INTO public.vendor_credit_notes (id, organization_id, business_id, branch_id, vendor_id,
                                          credit_note_number, credit_date, status, total, currency)
  VALUES (v_vcn, v_org, v_biz, v_branch, v_vendor, 'VCN-1', v_as_of - 15, 'confirmed', 500, 'USD');
  INSERT INTO public.vendor_credit_note_applications (id, credit_note_id, bill_id, amount, organization_id, business_id, applied_at)
  VALUES (gen_random_uuid(), v_vcn, v_bill_f, 300, v_org, v_biz, (v_as_of - 10)::timestamptz);

  SELECT residual_amount, aging_bucket INTO v_actual, v_bucket
    FROM public.finance_ap_open_items_as_of(v_org, v_biz, NULL, v_as_of) WHERE document_id = v_bill_a;
  IF v_actual <> 1000 OR v_bucket <> 'not_due' THEN RAISE EXCEPTION 'A: expected 1000/not_due, got %/%', v_actual, v_bucket; END IF;

  SELECT residual_amount, aging_bucket INTO v_actual, v_bucket
    FROM public.finance_ap_open_items_as_of(v_org, v_biz, NULL, v_as_of) WHERE document_id = v_bill_b;
  IF v_actual <> 500 OR v_bucket <> 'days30' THEN RAISE EXCEPTION 'B: expected 500/days30, got %/%', v_actual, v_bucket; END IF;

  SELECT residual_amount INTO v_actual
    FROM public.finance_ap_open_items_as_of(v_org, v_biz, NULL, v_as_of) WHERE document_id = v_bill_c;
  IF v_actual <> 600 THEN RAISE EXCEPTION 'C: expected 600, got %', v_actual; END IF;

  SELECT residual_amount INTO v_actual
    FROM public.finance_ap_open_items_as_of(v_org, v_biz, NULL, v_as_of) WHERE document_id = v_bill_d;
  IF v_actual <> 500 THEN RAISE EXCEPTION 'D: expected 500, got %', v_actual; END IF;

  SELECT COALESCE(SUM(residual_amount), 0) INTO v_actual
    FROM public.finance_ap_open_items_as_of(v_org, v_biz, NULL, v_as_of)
   WHERE document_id IN (v_bill_e1, v_bill_e2);
  IF v_actual <> 500 THEN RAISE EXCEPTION 'E: expected 500 across both bills, got %', v_actual; END IF;

  SELECT residual_amount INTO v_actual
    FROM public.finance_ap_open_items_as_of(v_org, v_biz, NULL, v_as_of) WHERE document_id = v_bill_f;
  IF v_actual <> 500 THEN RAISE EXCEPTION 'F: expected 500 after credit, got %', v_actual; END IF;
  SELECT COALESCE(SUM(credit_amount), 0) INTO v_actual
    FROM public.finance_ap_vendor_credit_as_of(v_org, v_biz, NULL, v_as_of);
  IF v_actual <> 200 THEN RAISE EXCEPTION 'F: expected 200 unapplied credit, got %', v_actual; END IF;

  SELECT residual_amount INTO v_actual
    FROM public.finance_ap_open_items_as_of(v_org, v_biz, NULL, v_as_of) WHERE document_id = v_bill_g;
  IF v_actual <> 700 THEN RAISE EXCEPTION 'G: reversed payment still reduced the payable (got %)', v_actual; END IF;

  SELECT residual_amount INTO v_actual
    FROM public.finance_ap_open_items_as_of(v_org, v_biz, NULL, v_as_of - 6) WHERE document_id = v_bill_c;
  IF v_actual <> 1000 THEN RAISE EXCEPTION 'H: historical re-run leaked a later payment — expected 1000, got %', v_actual; END IF;
  SELECT COALESCE(SUM(credit_amount), 0) INTO v_actual
    FROM public.finance_ap_vendor_credit_as_of(v_org, v_biz, NULL, v_as_of - 20);
  IF v_actual <> 0 THEN RAISE EXCEPTION 'H: credit note surfaced before its credit date (%)', v_actual; END IF;

  SELECT residual_amount, base_residual_amount INTO v_actual, v_total
    FROM public.finance_ap_open_items_as_of(v_org, v_biz, NULL, v_as_of) WHERE document_id = v_bill_i;
  IF v_actual <> 100 OR v_total <> 110 THEN RAISE EXCEPTION 'I: expected 100 EUR / 110 base, got % / %', v_actual, v_total; END IF;

  IF EXISTS (SELECT 1 FROM public.finance_ap_open_items_as_of(v_org, v_biz, v_branch, v_as_of) WHERE document_id = v_bill_j) THEN
    RAISE EXCEPTION 'J: a second-branch bill leaked into a branch-scoped report';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.finance_ap_open_items_as_of(v_org, v_biz, v_branch2, v_as_of) WHERE document_id = v_bill_j) THEN
    RAISE EXCEPTION 'J: the second-branch bill is missing from its own branch report';
  END IF;

  SELECT COALESCE(SUM(base_residual_amount), 0) INTO v_total
    FROM public.finance_ap_open_items_as_of(v_org, v_biz, NULL, v_as_of);

  SELECT s.total_residual INTO v_actual FROM public.get_ap_summary(v_org, v_biz, NULL, v_as_of) s;
  IF abs(COALESCE(v_actual, -1) - (v_total - 200)) > 0.05 THEN
    RAISE EXCEPTION 'AP KPI total % disagrees with the engine net of credit %', v_actual, v_total - 200;
  END IF;

  SELECT ((public.get_ap_aging_summary(v_org, v_biz, NULL, v_as_of) -> 'totals') ->> 'total')::numeric INTO v_actual;
  IF abs(COALESCE(v_actual, -1) - (v_total - 200)) > 0.05 THEN
    RAISE EXCEPTION 'Aged Payables total % disagrees with the engine net of credit %', v_actual, v_total - 200;
  END IF;

  SELECT r.aging_total INTO v_actual FROM public.finance_ap_aging_reconciliation(v_org, v_biz, NULL, v_as_of) r;
  IF abs(COALESCE(v_actual, -1) - (v_total - 200)) > 0.05 THEN
    RAISE EXCEPTION 'Reconciliation aging total % disagrees with the engine net of credit %', v_actual, v_total - 200;
  END IF;

  RAISE NOTICE 'AP aging as-of scenarios A-J and cross-surface equality hold (engine gross %)', v_total;
  RAISE EXCEPTION 'rollback: behavioural block complete';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'rollback: behavioural block complete' THEN RAISE; END IF;
END $$;
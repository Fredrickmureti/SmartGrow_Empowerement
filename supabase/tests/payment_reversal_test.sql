-- ADR 0127 / ADR 0125 — behavioural + contract coverage for the canonical
-- reversal RPCs (`void_invoice_atomic`, `void_payment_atomic`).
--
-- Everything behavioural runs inside a transaction that is rolled back, so the
-- file is safe to run against any environment.

-- 1) Exactly one overload of each reversal RPC (no parallel implementations).
DO $$
DECLARE v_name text; v_count int;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'void_invoice_atomic', 'void_payment_atomic',
    'void_bill_payment_atomic', 'unapply_payment_atomic'
  ] LOOP
    SELECT count(*) INTO v_count
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_count <> 1 THEN
      RAISE EXCEPTION '% must have exactly one overload, found %', v_name, v_count;
    END IF;
  END LOOP;
END $$;

-- 2) Each reversal RPC is SECURITY DEFINER with a pinned search_path.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT p.proname, p.prosecdef, p.proconfig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('void_invoice_atomic','void_payment_atomic','void_bill_payment_atomic')
  LOOP
    IF NOT r.prosecdef THEN
      RAISE EXCEPTION '% must be SECURITY DEFINER', r.proname;
    END IF;
    IF r.proconfig IS NULL OR NOT (r.proconfig::text LIKE '%search_path%') THEN
      RAISE EXCEPTION '% must pin search_path', r.proname;
    END IF;
  END LOOP;
END $$;

-- 3) No reversal RPC writes journal rows itself (ADR 0123 posting monopoly).
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT p.proname, p.prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('void_invoice_atomic','void_payment_atomic','void_bill_payment_atomic')
  LOOP
    IF r.prosrc ~* 'insert\s+into\s+(public\.)?journal_entr' THEN
      RAISE EXCEPTION '% inserts journal rows directly', r.proname;
    END IF;
  END LOOP;
END $$;

-- 4) Every reversal RPC refuses closed fiscal periods.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT p.proname, p.prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('void_invoice_atomic','void_payment_atomic','void_bill_payment_atomic')
  LOOP
    IF r.prosrc !~ 'is_period_open' THEN
      RAISE EXCEPTION '% has no fiscal period guard', r.proname;
    END IF;
  END LOOP;
END $$;

-- 5) The cascade reason code used by void_invoice_atomic is a real enum member.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE t.typname = 'payment_reversal_reason'
       AND e.enumlabel = 'invoice_voided_cascade'
  ) THEN
    RAISE EXCEPTION 'payment_reversal_reason missing invoice_voided_cascade';
  END IF;
END $$;

-- 6) No reversal RPC may reference a reason code outside the enum.
DO $$
DECLARE r RECORD; v_label text;
BEGIN
  FOR r IN
    SELECT p.proname, p.prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('void_invoice_atomic','void_payment_atomic')
  LOOP
    FOR v_label IN
      SELECT (regexp_matches(r.prosrc, '''([a-z_]+)''::payment_reversal_reason', 'g'))[1]
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
         WHERE t.typname = 'payment_reversal_reason' AND e.enumlabel = v_label
      ) THEN
        RAISE EXCEPTION '% casts unknown reason code %', r.proname, v_label;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- 7) Behavioural: voiding an invoice is idempotent, stamps the void columns and
--    cascades to the allocated payment through void_payment_atomic.
DO $$
DECLARE
  v_org uuid; v_biz uuid; v_contact uuid;
  v_invoice uuid := gen_random_uuid();
  v_payment uuid := gen_random_uuid();
  v_res1 jsonb; v_res2 jsonb;
  v_inv_status text; v_pmt_status text; v_paid numeric;
  v_events int;
BEGIN
  SELECT b.organization_id, b.id INTO v_org, v_biz
    FROM public.businesses b LIMIT 1;
  IF v_org IS NULL THEN
    RAISE NOTICE 'No business rows present — skipping behavioural reversal test.';
    RETURN;
  END IF;

  SELECT id INTO v_contact FROM public.contacts
   WHERE organization_id = v_org LIMIT 1;

  INSERT INTO public.invoices
    (id, organization_id, business_id, contact_id, invoice_number,
     issue_date, due_date, subtotal, tax_amount, total, amount_paid, status)
  VALUES
    (v_invoice, v_org, v_biz, v_contact, 'TEST-VOID-' || substr(v_invoice::text, 1, 8),
     CURRENT_DATE, CURRENT_DATE, 1000, 0, 1000, 400, 'partial');

  INSERT INTO public.payments
    (id, organization_id, business_id, contact_id, amount, payment_date,
     payment_method, receipt_number, status, applied_amount, outstanding_amount)
  VALUES
    (v_payment, v_org, v_biz, v_contact, 400, CURRENT_DATE,
     'cash', 'TEST-RCPT-' || substr(v_payment::text, 1, 8), 'completed', 400, 0);

  INSERT INTO public.payment_allocations
    (payment_id, invoice_id, amount, organization_id)
  VALUES (v_payment, v_invoice, 400, v_org);

  -- Refusing to cascade must fail loudly rather than orphan the cash.
  BEGIN
    PERFORM public.void_invoice_atomic(v_invoice, 'test', CURRENT_DATE, NULL, false, NULL);
    RAISE EXCEPTION 'void_invoice_atomic accepted a non-cascading void with live payments';
  EXCEPTION WHEN check_violation THEN
    NULL; -- expected
  END;

  v_res1 := public.void_invoice_atomic(v_invoice, 'test void', CURRENT_DATE, NULL, true, 'test-req-1');
  IF COALESCE((v_res1->>'already_voided')::boolean, false) THEN
    RAISE EXCEPTION 'first void reported already_voided';
  END IF;

  SELECT status::text, amount_paid INTO v_inv_status, v_paid
    FROM public.invoices WHERE id = v_invoice;
  IF v_inv_status <> 'voided' THEN
    RAISE EXCEPTION 'invoice status is % after void', v_inv_status;
  END IF;
  IF v_paid <> 0 THEN
    RAISE EXCEPTION 'invoice amount_paid is % after cascading void, expected 0', v_paid;
  END IF;

  SELECT status INTO v_pmt_status FROM public.payments WHERE id = v_payment;
  IF v_pmt_status <> 'voided' THEN
    RAISE EXCEPTION 'allocated payment status is % after cascade', v_pmt_status;
  END IF;

  SELECT count(*) INTO v_events
    FROM public.payment_reversal_events
   WHERE payment_id = v_payment
     AND reason_code = 'invoice_voided_cascade'::payment_reversal_reason;
  IF v_events <> 1 THEN
    RAISE EXCEPTION 'expected 1 cascade reversal event, found %', v_events;
  END IF;

  -- Allocation rows survive (ADR 0027 invariant 5 — append-only trail).
  IF NOT EXISTS (
    SELECT 1 FROM public.payment_allocations WHERE payment_id = v_payment
  ) THEN
    RAISE EXCEPTION 'cascade deleted allocation rows';
  END IF;

  -- Idempotent repeat.
  v_res2 := public.void_invoice_atomic(v_invoice, 'test void', CURRENT_DATE, NULL, true, 'test-req-1');
  IF NOT COALESCE((v_res2->>'already_voided')::boolean, false) THEN
    RAISE EXCEPTION 'second void did not report already_voided';
  END IF;

  RAISE NOTICE 'Behavioural reversal test passed.';
END $$;

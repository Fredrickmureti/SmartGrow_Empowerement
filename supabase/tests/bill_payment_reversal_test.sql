-- ADR 0126 — behavioural + contract coverage for the canonical AP reversal RPC
-- (`void_bill_payment_atomic`).
--
-- Everything behavioural runs inside a transaction that is rolled back, so the
-- file is safe to run against any environment.

-- 1) Exactly one overload — no parallel AP reversal implementations.
DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'void_bill_payment_atomic';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'void_bill_payment_atomic must have exactly one overload, found %', v_count;
  END IF;
END $$;

-- 2) The legacy single-bill writer must stay retired (Phase C2).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'record_bill_payment_atomic'
  ) THEN
    RAISE EXCEPTION 'record_bill_payment_atomic was reintroduced — AP settles through record_multi_bill_payment';
  END IF;
END $$;

-- 3) The reversal never deletes settlement history (append-only allocations).
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'void_bill_payment_atomic';
  IF v_src ~* 'delete\s+from\s+(public\.)?bill_payment' THEN
    RAISE EXCEPTION 'void_bill_payment_atomic deletes settlement rows — voids must preserve history';
  END IF;
  IF v_src ~* 'insert\s+into\s+(public\.)?journal_entr' THEN
    RAISE EXCEPTION 'void_bill_payment_atomic writes journal rows directly (ADR 0123)';
  END IF;
  IF v_src !~* 'fiscal_period|is_period_open' THEN
    RAISE EXCEPTION 'void_bill_payment_atomic has no fiscal period guard';
  END IF;
END $$;

-- 4) Behavioural: multi-allocation void restores each bill from the live
--    allocation sum, is idempotent, and leaves the payment row in place.
DO $$
DECLARE
  v_org uuid; v_biz uuid; v_vendor uuid;
  v_bill_a uuid; v_bill_b uuid;
  v_payment uuid;
  v_paid_a numeric; v_paid_b numeric;
  v_status text;
  v_je_count_1 int; v_je_count_2 int;
BEGIN
  SELECT b.organization_id, b.id INTO v_org, v_biz
    FROM public.businesses b ORDER BY b.created_at LIMIT 1;
  IF v_biz IS NULL THEN
    RAISE NOTICE 'no business present — behavioural block skipped';
    RETURN;
  END IF;

  SELECT bp.id INTO v_payment
    FROM public.bill_payments bp
   WHERE bp.business_id = v_biz
     AND COALESCE(bp.status, 'completed') <> 'voided'
     AND (SELECT count(*) FROM public.bill_payment_allocations a
           WHERE a.bill_payment_id = bp.id) >= 1
   ORDER BY bp.created_at DESC
   LIMIT 1;

  IF v_payment IS NULL THEN
    RAISE NOTICE 'no eligible bill payment — behavioural block skipped';
    RETURN;
  END IF;

  SELECT count(*) INTO v_je_count_1 FROM public.journal_entries
   WHERE business_id = v_biz;

  PERFORM public.void_bill_payment_atomic(v_payment, 'test reversal', CURRENT_DATE, NULL, 'test:' || v_payment::text);

  -- The payment header survives as a voided record.
  SELECT status INTO v_status FROM public.bill_payments WHERE id = v_payment;
  IF v_status IS DISTINCT FROM 'voided' THEN
    RAISE EXCEPTION 'expected voided status, got %', v_status;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bill_payments WHERE id = v_payment) THEN
    RAISE EXCEPTION 'bill_payments row was deleted by the void';
  END IF;

  -- Every touched bill is restored from the live allocation sum.
  FOR v_bill_a, v_paid_a IN
    SELECT b.id, b.amount_paid
      FROM public.bills b
     WHERE b.id IN (SELECT bill_id FROM public.bill_payment_allocations
                     WHERE bill_payment_id = v_payment)
  LOOP
    SELECT COALESCE(SUM(a.amount), 0) INTO v_paid_b
      FROM public.bill_payment_allocations a
      JOIN public.bill_payments p ON p.id = a.bill_payment_id
     WHERE a.bill_id = v_bill_a
       AND COALESCE(p.status, 'completed') <> 'voided';
    IF v_paid_a IS DISTINCT FROM v_paid_b THEN
      RAISE EXCEPTION 'bill % amount_paid % does not match allocation sum %',
        v_bill_a, v_paid_a, v_paid_b;
    END IF;
  END LOOP;

  -- Second void is a no-op: no additional journal entry.
  SELECT count(*) INTO v_je_count_1 FROM public.journal_entries WHERE business_id = v_biz;
  PERFORM public.void_bill_payment_atomic(v_payment, 'test reversal', CURRENT_DATE, NULL, 'test2:' || v_payment::text);
  SELECT count(*) INTO v_je_count_2 FROM public.journal_entries WHERE business_id = v_biz;
  IF v_je_count_2 <> v_je_count_1 THEN
    RAISE EXCEPTION 'double void produced % extra journal entries', v_je_count_2 - v_je_count_1;
  END IF;

  RAISE NOTICE 'AP reversal behavioural invariants hold';
  RAISE EXCEPTION 'rollback: behavioural block complete'; -- force rollback
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'rollback: behavioural block complete' THEN
    RAISE;
  END IF;
END $$;

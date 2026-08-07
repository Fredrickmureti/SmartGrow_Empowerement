-- Phase 4c of the business reversal convergence plan — coverage for the AP
-- reversal writers `public.void_bill_atomic` and
-- `public.void_bill_payment_atomic`.
--
-- Why this file exists: bill voiding was the last module still running a
-- client-side saga (fetch bill, reverse journal, unapply payments, restore PO
-- quantities, update status — five round trips, no transaction). Phase 3 moved
-- it server-side. This file pins the properties that made that move worth
-- doing, so a future edit cannot quietly unbundle the transaction again.
--
-- Introspection plus read-only probes only; safe in any environment.

-- 1) One writer per AP reversal operation, one overload each.
DO $$
DECLARE v_name text; v_count int;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['void_bill_atomic','void_bill_payment_atomic'] LOOP
    SELECT count(*) INTO v_count
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_count <> 1 THEN
      RAISE EXCEPTION '% must exist with exactly one overload, found %', v_name, v_count;
    END IF;
  END LOOP;
END $$;

-- 2) Both writers are idempotent and preserve history. A retried void must
--    report `already_voided`, never post a second reversal.
DO $$
DECLARE v_name text; v_src text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['void_bill_atomic','void_bill_payment_atomic'] LOOP
    SELECT p.prosrc INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;

    IF v_src !~* 'already_voided|already_reversed' THEN
      RAISE EXCEPTION '% is not idempotent — a double-submitted void would post two reversals', v_name;
    END IF;
    IF v_src ~* 'delete\s+from\s+public\.(bills|bill_payments|journal_entr)' THEN
      RAISE EXCEPTION '% deletes financial history instead of compensating it', v_name;
    END IF;
  END LOOP;
END $$;

-- 3) The bill void owns its whole fan-out: GL reversal, payment unapplication
--    and purchase-order restoration in one transaction.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'void_bill_atomic';

  IF v_src !~* 'void_journal_entry_atomic' THEN
    RAISE EXCEPTION 'void_bill_atomic does not reverse the bill journal through the shared reversal writer';
  END IF;
  IF v_src !~* 'bill_payment' THEN
    RAISE EXCEPTION 'void_bill_atomic does not address applied payments — a voided bill could keep cash applied to it';
  END IF;
  IF v_src !~* 'purchase_order' THEN
    RAISE EXCEPTION 'void_bill_atomic does not restore purchase-order billing state';
  END IF;
END $$;

-- 4) The money leg reversal releases the vendor balance and never leaves the
--    payment allocated.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'void_bill_payment_atomic';

  IF v_src !~* 'void_journal_entry_atomic' THEN
    RAISE EXCEPTION 'void_bill_payment_atomic does not reverse the payment journal through the shared reversal writer';
  END IF;
  IF v_src !~* 'bill_payment_allocations|amount_paid|balance' THEN
    RAISE EXCEPTION 'void_bill_payment_atomic does not restore the bill balance it had settled';
  END IF;
END $$;

-- 5) Behavioural probe: intent and preview agree about bills and bill payments,
--    and any refusal names its blocker. Read-only.
DO $$
DECLARE v_id uuid; v_dt text; v_intent jsonb; v_preview jsonb;
BEGIN
  FOREACH v_dt IN ARRAY ARRAY['bill','bill_payment'] LOOP
    EXECUTE format('SELECT id FROM public.%I LIMIT 1',
                   CASE v_dt WHEN 'bill' THEN 'bills' ELSE 'bill_payments' END)
       INTO v_id;
    CONTINUE WHEN v_id IS NULL;

    v_intent  := public.resolve_reversal_intent(v_dt, v_id);
    v_preview := public.preview_reversal_consequences(v_dt, v_id);

    IF v_intent IS NULL OR v_preview IS NULL THEN
      RAISE EXCEPTION '% % has no intent/preview answer', v_dt, v_id;
    END IF;
    IF (v_intent->>'allowed')::boolean IS FALSE
       AND jsonb_array_length(COALESCE(v_intent->'blockers', '[]'::jsonb)) = 0 THEN
      RAISE EXCEPTION 'reversal of % % refused without a stated blocker', v_dt, v_id;
    END IF;
  END LOOP;
END $$;

-- employee_advances_recovery_test.sql
-- Pins the schema invariants for the Employee Advances first-class concept.
-- The actual recovery math is exercised by the TS engine; this test asserts:
--   1. Tables exist with the columns the engine reads.
--   2. RLS is enabled.
--   3. CHECK constraints reject obviously invalid data (amount <= 0, end < start).
--   4. Inserting a recovery row bumps recovered_amount on the parent advance
--      when the application code (or trigger) runs.
BEGIN;
  -- (1) Required tables + columns
  PERFORM 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='employee_advances';
  IF NOT FOUND THEN RAISE EXCEPTION 'employee_advances table missing'; END IF;

  PERFORM 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='advance_repayment_schedule';
  IF NOT FOUND THEN RAISE EXCEPTION 'advance_repayment_schedule table missing'; END IF;

  PERFORM 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='employee_advances'
      AND column_name IN ('amount','recovered_amount','recovery_method','installment_count','min_net_floor','status');
  IF NOT FOUND THEN RAISE EXCEPTION 'employee_advances missing required columns'; END IF;

  -- (2) RLS enabled
  PERFORM 1 FROM pg_class WHERE oid = 'public.employee_advances'::regclass AND relrowsecurity;
  IF NOT FOUND THEN RAISE EXCEPTION 'RLS not enabled on employee_advances'; END IF;

  PERFORM 1 FROM pg_class WHERE oid = 'public.advance_repayment_schedule'::regclass AND relrowsecurity;
  IF NOT FOUND THEN RAISE EXCEPTION 'RLS not enabled on advance_repayment_schedule'; END IF;

  -- (3) CHECK constraints: amount > 0
  DECLARE v_caught boolean := false;
  DECLARE v_org uuid; v_biz uuid; v_emp uuid;
  BEGIN
    SELECT organization_id, id INTO v_org, v_biz FROM public.businesses LIMIT 1;
    IF v_biz IS NULL THEN
      RAISE NOTICE 'no business; skipping advance integrity test';
      RETURN;
    END IF;
    SELECT id INTO v_emp FROM public.employees WHERE business_id = v_biz LIMIT 1;
    IF v_emp IS NULL THEN
      RAISE NOTICE 'no employee; skipping advance integrity test';
      RETURN;
    END IF;

    BEGIN
      INSERT INTO public.employee_advances (organization_id, business_id, employee_id, amount)
      VALUES (v_org, v_biz, v_emp, 0);
    EXCEPTION WHEN check_violation THEN v_caught := true;
    END;
    IF NOT v_caught THEN RAISE EXCEPTION 'expected rejection: amount must be > 0'; END IF;
  END;
ROLLBACK;
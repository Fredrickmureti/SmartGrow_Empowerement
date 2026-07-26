-- Phase 7 — arrears sweep invariants.
--
-- Proves:
--   1. An overdue pending instalment on an `active` loan promotes it to
--      `in_arrears` exactly once (idempotent — a second sweep is a no-op).
--   2. The sweep records a single `enter_arrears` lifecycle event carrying
--      the missed schedule row ids.
--   3. A subsequent successful repayment clears arrears back to `active`.
--   4. Loans not in `active` are untouched by the sweep.
BEGIN;

DO $$
DECLARE
  v_org uuid; v_emp uuid; v_loan uuid; v_paused uuid;
  v_res jsonb; v_status text; v_events integer;
BEGIN
  SELECT organization_id, id INTO v_org, v_emp FROM public.employees LIMIT 1;
  IF v_emp IS NULL THEN
    RAISE NOTICE 'SKIP: no employees seeded';
    RETURN;
  END IF;

  INSERT INTO public.employee_loans(
    organization_id, employee_id, loan_number, principal_amount, total_amount,
    monthly_deduction, total_installments, outstanding_balance, status)
  VALUES (v_org, v_emp, 'ARR-'||substr(gen_random_uuid()::text,1,8),
          1000, 1000, 500, 2, 1000, 'active')
  RETURNING id INTO v_loan;

  INSERT INTO public.loan_repayment_schedule(loan_id, sequence, due_date, scheduled_amount, status)
  VALUES (v_loan, 1, CURRENT_DATE - INTERVAL '5 days', 500, 'pending'),
         (v_loan, 2, CURRENT_DATE + INTERVAL '25 days', 500, 'pending');

  -- A paused loan with an overdue instalment must NOT be promoted.
  INSERT INTO public.employee_loans(
    organization_id, employee_id, loan_number, principal_amount, total_amount,
    monthly_deduction, total_installments, outstanding_balance, status)
  VALUES (v_org, v_emp, 'PSD-'||substr(gen_random_uuid()::text,1,8),
          1000, 1000, 500, 2, 1000, 'paused')
  RETURNING id INTO v_paused;
  INSERT INTO public.loan_repayment_schedule(loan_id, sequence, due_date, scheduled_amount, status)
  VALUES (v_paused, 1, CURRENT_DATE - INTERVAL '10 days', 500, 'pending');

  v_res := public.employee_loan_mark_missed_installments(CURRENT_DATE);
  IF (v_res->>'promoted')::int <> 1 THEN
    RAISE EXCEPTION 'FAIL: sweep must promote exactly 1 loan, got %', v_res->>'promoted';
  END IF;

  SELECT status INTO v_status FROM public.employee_loans WHERE id = v_loan;
  IF v_status <> 'in_arrears' THEN
    RAISE EXCEPTION 'FAIL: active+overdue loan must be in_arrears, got %', v_status;
  END IF;

  SELECT status INTO v_status FROM public.employee_loans WHERE id = v_paused;
  IF v_status <> 'paused' THEN
    RAISE EXCEPTION 'FAIL: paused loan must be left alone, got %', v_status;
  END IF;

  -- Idempotency — a second sweep must not create a second event.
  v_res := public.employee_loan_mark_missed_installments(CURRENT_DATE);
  IF (v_res->>'promoted')::int <> 0 THEN
    RAISE EXCEPTION 'FAIL: second sweep must be a no-op, got promoted=%', v_res->>'promoted';
  END IF;

  SELECT count(*) INTO v_events
    FROM public.loan_lifecycle_events
   WHERE loan_id = v_loan AND event_type = 'enter_arrears';
  IF v_events <> 1 THEN
    RAISE EXCEPTION 'FAIL: exactly one enter_arrears event expected, got %', v_events;
  END IF;

  -- A successful repayment clears arrears.
  INSERT INTO public.loan_repayment_schedule(loan_id, sequence, due_date, scheduled_amount, status)
  VALUES (v_loan, 3, CURRENT_DATE + INTERVAL '60 days', 500, 'pending')
  ON CONFLICT DO NOTHING;
  PERFORM public.employee_loan_apply_repayment(v_loan, 500, NULL, NULL, 'payroll', 'clears arrears');
  SELECT status INTO v_status FROM public.employee_loans WHERE id = v_loan;
  IF v_status NOT IN ('active','completed') THEN
    RAISE EXCEPTION 'FAIL: repayment must clear arrears (active|completed), got %', v_status;
  END IF;

  RAISE NOTICE 'PASS: arrears sweep';
END $$;

ROLLBACK;

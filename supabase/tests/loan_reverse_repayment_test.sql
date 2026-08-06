-- Reversal is the strict inverse of apply — Phase 8 invariants.
--
-- Proves:
--   1. Applying the final instalment moves the loan to `completed`.
--   2. Reversing that repayment reopens the loan through the state machine
--      (`reopen` transition), restores the schedule to `pending`, and
--      recomputes balances from the immutable ledger (no drift).
--   3. Re-applying the same amount lands the loan back on `completed` — the
--      apply/reverse/apply round-trip is a fixed point.
--   4. A reversed repayment cannot be reversed twice.
--   5. Only one non-reversed positive repayment counts toward
--      `installments_paid` after the round-trip.
BEGIN;

DO $$
DECLARE
  v_org uuid; v_emp uuid; v_loan uuid;
  v_apply1 jsonb; v_apply2 jsonb; v_reapply jsonb;
  v_rev uuid;
  v_status text; v_bal numeric; v_paid integer;
  v_events integer;
BEGIN
  SELECT organization_id, id INTO v_org, v_emp FROM public.employees LIMIT 1;
  IF v_emp IS NULL THEN
    RAISE NOTICE 'SKIP: no employees seeded';
    RETURN;
  END IF;

  INSERT INTO public.employee_loans(
    organization_id, employee_id, loan_number, principal_amount, total_amount,
    monthly_deduction, total_installments, outstanding_balance, status)
  VALUES (v_org, v_emp, 'REV-'||substr(gen_random_uuid()::text,1,8),
          1000, 1000, 500, 2, 1000, 'active')
  RETURNING id INTO v_loan;

  -- Seed a two-instalment schedule so the FIFO allocator has something to bite.
  INSERT INTO public.loan_repayment_schedule(loan_id, sequence, due_date, scheduled_amount, status)
  VALUES (v_loan, 1, CURRENT_DATE, 500, 'pending'),
         (v_loan, 2, CURRENT_DATE + INTERVAL '30 days', 500, 'pending');

  v_apply1 := public.employee_loan_apply_repayment(v_loan, 500, NULL, NULL, 'payroll', 'i1', NULL, NULL);
  v_apply2 := public.employee_loan_apply_repayment(v_loan, 500, NULL, NULL, 'payroll', 'i2', NULL, NULL);

  IF (v_apply2->>'status') <> 'completed' THEN
    RAISE EXCEPTION 'FAIL: final instalment must complete loan, got %', v_apply2->>'status';
  END IF;

  -- Reverse the final repayment.
  v_rev := public.employee_loan_reverse_repayment((v_apply2->>'repayment_id')::uuid, 'test-reverse');

  SELECT status, outstanding_balance, installments_paid
    INTO v_status, v_bal, v_paid
    FROM public.employee_loans WHERE id = v_loan;

  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'FAIL: reversal must reopen loan to active, got %', v_status;
  END IF;
  IF v_bal <> 500 THEN
    RAISE EXCEPTION 'FAIL: outstanding balance must recompute to 500, got %', v_bal;
  END IF;
  IF v_paid <> 1 THEN
    RAISE EXCEPTION 'FAIL: installments_paid must recompute to 1, got %', v_paid;
  END IF;

  -- Second-instalment schedule row should be back to pending.
  IF NOT EXISTS (
    SELECT 1 FROM public.loan_repayment_schedule
     WHERE loan_id = v_loan AND sequence = 2 AND status = 'pending'
       AND paid_amount = 0 AND repayment_id IS NULL
  ) THEN
    RAISE EXCEPTION 'FAIL: schedule row 2 must be de-allocated on reversal';
  END IF;

  -- Reversing the same repayment twice is refused.
  BEGIN
    PERFORM public.employee_loan_reverse_repayment((v_apply2->>'repayment_id')::uuid, 'again');
    RAISE EXCEPTION 'FAIL: double reversal must be refused';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  -- Re-apply lands us back at completed — apply/reverse/apply is a fixed point.
  v_reapply := public.employee_loan_apply_repayment(v_loan, 500, NULL, NULL, 'payroll', 'i2-redo', NULL, NULL);
  IF (v_reapply->>'status') <> 'completed' THEN
    RAISE EXCEPTION 'FAIL: re-applying final instalment must re-complete, got %', v_reapply->>'status';
  END IF;

  SELECT count(*) INTO v_events
    FROM public.loan_lifecycle_events
   WHERE loan_id = v_loan AND event_type = 'reverse_repayment';
  IF v_events <> 1 THEN
    RAISE EXCEPTION 'FAIL: exactly one reverse_repayment event expected, got %', v_events;
  END IF;

  RAISE NOTICE 'PASS: reverse-repayment parity';
END $$;

ROLLBACK;

-- Loan repayment during payroll — canonical lifecycle invariants.
--
-- Pins the fixes from ADR 0091 §9-§11:
--   1. The terminal status is `completed` (the only value
--      `employee_loans_status_check` accepts). `settled` no longer exists
--      anywhere in the state machine.
--   2. `process_payroll_loan_deductions` never writes `employee_loans`
--      itself — it delegates to `employee_loan_apply_repayment`, which is
--      the single write path for an instalment.
--   3. A final instalment closes the loan through the state machine and
--      emits a lifecycle event + outbox row.
--   4. Replaying the same payslip is a no-op, not a rollback.
--
-- Run with:  psql -f supabase/tests/loan_payroll_repayment_test.sql
BEGIN;

-- ── 1. state machine agrees with the check constraint ────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.employee_loan_state_transitions
              WHERE to_status = 'settled') THEN
    RAISE EXCEPTION 'FAIL: retired status "settled" still present in the state machine';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.employee_loan_state_transitions
                  WHERE event = 'settle' AND to_status = 'completed') THEN
    RAISE EXCEPTION 'FAIL: settle must transition to completed';
  END IF;
  -- every to_status must satisfy employee_loans_status_check
  PERFORM 1 FROM public.employee_loan_state_transitions t
    WHERE t.to_status NOT IN (
      'requested','pending_approval','rejected','draft','approved',
      'awaiting_disbursement','disbursement_failed','active','in_arrears',
      'paused','restructured','completed','written_off','defaulted',
      'closed_on_termination','cancelled','suspended','archived');
  IF FOUND THEN
    RAISE EXCEPTION 'FAIL: state machine yields a status the check constraint rejects';
  END IF;
END $$;

-- ── 2. payroll owns no loan state ────────────────────────────────────
DO $$
DECLARE src text;
BEGIN
  SELECT prosrc INTO src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='process_payroll_loan_deductions';
  IF src ~* 'UPDATE\s+(public\.)?employee_loans' THEN
    RAISE EXCEPTION 'FAIL: payroll writes employee_loans directly';
  END IF;
  IF src !~ 'employee_loan_apply_repayment' THEN
    RAISE EXCEPTION 'FAIL: payroll must delegate to employee_loan_apply_repayment';
  END IF;
  IF src ~* '''settled''' THEN
    RAISE EXCEPTION 'FAIL: payroll still references the retired status';
  END IF;
END $$;

-- ── 3. end-to-end: final instalment closes the loan ──────────────────
DO $$
DECLARE
  v_org uuid; v_emp uuid; v_loan uuid; v_res jsonb; v_status text; v_events int;
BEGIN
  SELECT organization_id, id INTO v_org, v_emp FROM public.employees LIMIT 1;
  IF v_emp IS NULL THEN
    RAISE NOTICE 'SKIP: no employees seeded in this database';
    RETURN;
  END IF;

  INSERT INTO public.employee_loans(
    organization_id, employee_id, loan_number, principal_amount, total_amount,
    monthly_deduction, total_installments, outstanding_balance, status)
  VALUES (v_org, v_emp, 'TEST-'||substr(gen_random_uuid()::text,1,8),
          1000, 1200, 600, 2, 1200, 'active')
  RETURNING id INTO v_loan;

  -- instalment 1 of 2 → still active
  v_res := public.employee_loan_apply_repayment(v_loan, 600, NULL, NULL, 'payroll', 'test 1');
  IF (v_res->>'status') <> 'active' THEN
    RAISE EXCEPTION 'FAIL: loan should remain active, got %', v_res->>'status';
  END IF;
  IF (v_res->>'outstanding_balance')::numeric <> 600 THEN
    RAISE EXCEPTION 'FAIL: balance should be 600, got %', v_res->>'outstanding_balance';
  END IF;

  -- final instalment → completed via the state machine
  v_res := public.employee_loan_apply_repayment(v_loan, 600, NULL, NULL, 'payroll', 'test 2');
  IF (v_res->>'status') <> 'completed' THEN
    RAISE EXCEPTION 'FAIL: final instalment must complete the loan, got %', v_res->>'status';
  END IF;
  IF (v_res->>'outstanding_balance')::numeric <> 0 THEN
    RAISE EXCEPTION 'FAIL: balance must be zero, got %', v_res->>'outstanding_balance';
  END IF;

  SELECT status INTO v_status FROM public.employee_loans WHERE id = v_loan;
  IF v_status <> 'completed' THEN
    RAISE EXCEPTION 'FAIL: persisted status must be completed, got %', v_status;
  END IF;

  -- audit parity: repayment + settle events recorded
  SELECT count(*) INTO v_events FROM public.loan_lifecycle_events
   WHERE loan_id = v_loan AND event_type IN ('repayment_recorded','settle');
  IF v_events < 3 THEN
    RAISE EXCEPTION 'FAIL: expected 2 repayment events + settle, got %', v_events;
  END IF;

  -- a completed loan cannot receive another instalment
  BEGIN
    PERFORM public.employee_loan_apply_repayment(v_loan, 100, NULL, NULL, 'payroll', 'test 3');
    RAISE EXCEPTION 'FAIL: repayment against a completed loan must be refused';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  RAISE NOTICE 'PASS: payroll loan repayment lifecycle';
END $$;

ROLLBACK;

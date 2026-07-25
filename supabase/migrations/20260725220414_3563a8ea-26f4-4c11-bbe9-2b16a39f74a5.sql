-- Phase 1: one terminal loan status ('completed'); retire 'settled'.
CREATE OR REPLACE VIEW public.employee_loan_state_transitions AS
SELECT from_status, event, to_status
FROM ( VALUES
  ('draft','submit','pending_approval'),
  ('requested','submit','pending_approval'),
  ('rejected','submit','pending_approval'),
  ('pending_approval','approve','approved'),
  ('pending_approval','reject','rejected'),
  ('pending_approval','cancel','cancelled'),
  ('approved','authorize_disbursement','awaiting_disbursement'),
  ('approved','cancel','cancelled'),
  ('awaiting_disbursement','disburse','active'),
  ('awaiting_disbursement','cancel_authorization','approved'),
  ('awaiting_disbursement','cancel','cancelled'),
  ('awaiting_disbursement','suspend','suspended'),
  ('active','enter_arrears','in_arrears'),
  ('active','pause','paused'),
  ('active','suspend','suspended'),
  ('active','settle','completed'),
  ('active','write_off','written_off'),
  ('active','restructure','restructured'),
  ('active','close_on_termination','closed_on_termination'),
  ('in_arrears','exit_arrears','active'),
  ('in_arrears','pause','paused'),
  ('in_arrears','settle','completed'),
  ('in_arrears','write_off','written_off'),
  ('in_arrears','restructure','restructured'),
  ('in_arrears','close_on_termination','closed_on_termination'),
  ('paused','resume','active'),
  ('paused','settle','completed'),
  ('paused','write_off','written_off'),
  ('paused','restructure','restructured'),
  ('paused','close_on_termination','closed_on_termination'),
  ('restructured','settle','completed'),
  ('suspended','resume','active'),
  ('suspended','cancel','cancelled')
) t(from_status, event, to_status);

CREATE OR REPLACE FUNCTION public.employee_loan_settle(_loan_id uuid)
RETURNS public.employee_loans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r public.employee_loans; prior text;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  IF r.id IS NULL THEN
    RAISE EXCEPTION 'Loan not found.' USING ERRCODE='22023', HINT='LOAN_CONTEXT_NOT_FOUND';
  END IF;
  prior := r.status;
  PERFORM public._loan_assert_transition(_loan_id, 'settle');
  IF r.outstanding_balance > 0.005 THEN
    RAISE EXCEPTION 'Loan still has an outstanding balance of %.', r.outstanding_balance
      USING ERRCODE='22023', HINT='LOAN_BALANCE_NONZERO';
  END IF;
  UPDATE public.employee_loans
     SET status='completed', end_date=COALESCE(end_date, CURRENT_DATE), updated_at=now()
   WHERE id=_loan_id RETURNING * INTO r;
  PERFORM public.loan_log_event(_loan_id,'settle',prior,'completed');
  RETURN r;
END $$;

-- Phase 2: canonical repayment-apply RPC — the single write path for an
-- instalment. Loans own state, balance, schedule progression, transitions.
CREATE OR REPLACE FUNCTION public.employee_loan_apply_repayment(
  _loan_id uuid,
  _amount numeric,
  _payroll_run_id uuid DEFAULT NULL,
  _payslip_id uuid DEFAULT NULL,
  _kind text DEFAULT 'payroll',
  _notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r            public.employee_loans;
  prior        text;
  existing_id  uuid;
  rep_id       uuid;
  remaining    numeric;
  alloc        numeric;
  sched        record;
  new_repaid   numeric;
  new_balance  numeric;
  completed    boolean := false;
BEGIN
  IF _amount IS NULL OR _amount <= 0 THEN
    RAISE EXCEPTION 'Repayment amount must be positive.'
      USING ERRCODE='22023', HINT='LOAN_AMOUNT_INVALID';
  END IF;

  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  IF r.id IS NULL THEN
    RAISE EXCEPTION 'Loan % not found.', _loan_id
      USING ERRCODE='22023', HINT='LOAN_CONTEXT_NOT_FOUND';
  END IF;
  prior := r.status;

  -- Idempotency: one payslip may never produce two instalments.
  IF _payslip_id IS NOT NULL THEN
    SELECT id INTO existing_id
      FROM public.loan_repayments
     WHERE loan_id = _loan_id AND payslip_id = _payslip_id
     LIMIT 1;
    IF existing_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'loan_id', _loan_id, 'repayment_id', existing_id,
        'status', r.status, 'outstanding_balance', r.outstanding_balance,
        'completed', false, 'already_applied', true);
    END IF;
  END IF;

  IF r.status NOT IN ('active','in_arrears','paused','restructured') THEN
    RAISE EXCEPTION 'A loan in status "%" cannot receive a repayment.', r.status
      USING ERRCODE='22023', HINT='LOAN_STATE_INVALID';
  END IF;

  INSERT INTO public.loan_repayments(
    loan_id, payroll_run_id, payslip_id, amount, installment_number, notes, kind)
  VALUES (
    _loan_id, _payroll_run_id, _payslip_id, _amount,
    COALESCE(r.installments_paid,0) + 1, _notes, COALESCE(_kind,'payroll'))
  RETURNING id INTO rep_id;

  remaining := _amount;
  FOR sched IN
    SELECT id, scheduled_amount, paid_amount
      FROM public.loan_repayment_schedule
     WHERE loan_id = _loan_id
       AND status IN ('pending','partial')
     ORDER BY sequence
     FOR UPDATE
  LOOP
    EXIT WHEN remaining <= 0;
    alloc := LEAST(remaining, GREATEST(sched.scheduled_amount - COALESCE(sched.paid_amount,0), 0));
    IF alloc <= 0 THEN CONTINUE; END IF;
    UPDATE public.loan_repayment_schedule
       SET paid_amount = COALESCE(paid_amount,0) + alloc,
           status = CASE WHEN COALESCE(paid_amount,0) + alloc >= scheduled_amount
                         THEN 'paid' ELSE 'partial' END,
           payslip_id   = COALESCE(payslip_id, _payslip_id),
           repayment_id = COALESCE(repayment_id, rep_id),
           updated_at   = now()
     WHERE id = sched.id;
    remaining := remaining - alloc;
  END LOOP;

  new_repaid  := COALESCE(r.amount_repaid,0) + _amount;
  new_balance := GREATEST(COALESCE(r.total_amount,0) - new_repaid, 0);

  UPDATE public.employee_loans
     SET amount_repaid       = new_repaid,
         outstanding_balance = new_balance,
         installments_paid   = COALESCE(installments_paid,0) + 1,
         updated_at          = now()
   WHERE id = _loan_id;

  PERFORM public.loan_log_event(_loan_id, 'repayment_recorded', prior, prior);

  -- Arrears clear through the canonical event, never an inline write.
  IF prior = 'in_arrears' THEN
    PERFORM public.employee_loan_clear_arrears(_loan_id);
  END IF;

  -- Completion runs through the state machine, never as a status literal.
  IF new_balance <= 0.005 THEN
    PERFORM public.employee_loan_settle(_loan_id);
    completed := true;
  END IF;

  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id;

  RETURN jsonb_build_object(
    'loan_id', _loan_id, 'repayment_id', rep_id,
    'status', r.status, 'outstanding_balance', r.outstanding_balance,
    'completed', completed, 'already_applied', false);
END $$;

-- Phase 3: payroll delegates; it no longer owns loan state.
CREATE OR REPLACE FUNCTION public.process_payroll_loan_deductions(
  _payroll_run_id uuid,
  _payroll_number text,
  _deductions jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _ld jsonb;
  _amount numeric;
BEGIN
  FOR _ld IN SELECT * FROM jsonb_array_elements(_deductions)
  LOOP
    _amount := COALESCE((_ld->>'amount')::numeric, 0);
    IF _amount <= 0 THEN CONTINUE; END IF;
    PERFORM public.employee_loan_apply_repayment(
      (_ld->>'loan_id')::uuid,
      _amount,
      _payroll_run_id,
      NULLIF(_ld->>'payslip_id','')::uuid,
      'payroll',
      'Auto-deducted via payroll ' || COALESCE(_payroll_number,'')
    );
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION public.employee_loan_apply_repayment(uuid, numeric, uuid, uuid, text, text) TO authenticated, service_role;
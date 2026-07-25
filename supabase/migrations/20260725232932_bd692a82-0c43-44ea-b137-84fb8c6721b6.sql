-- Phase 6 — Termination settlement (retry after view-vs-table correction).

-- 1. Extend loan_repayments.kind to cover termination flows.
ALTER TABLE public.loan_repayments
  DROP CONSTRAINT IF EXISTS loan_repayments_kind_check;
ALTER TABLE public.loan_repayments
  ADD CONSTRAINT loan_repayments_kind_check
  CHECK (kind = ANY (ARRAY[
    'payroll','manual','external','reversal','writeoff',
    'termination_recovery','termination_writeoff']));

-- 2. Redefine the state-machine view to add `restructured -> close_on_termination`.
-- (The view is a hardcoded VALUES list; adding one row means CREATE OR REPLACE.)
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
  ('restructured','close_on_termination','closed_on_termination'),
  ('suspended','resume','active'),
  ('suspended','cancel','cancelled')
) t(from_status, event, to_status);

-- 3. Extended apply_repayment (8-arg): optional terminal-event routing.
CREATE OR REPLACE FUNCTION public.employee_loan_apply_repayment(
  _loan_id uuid,
  _amount numeric,
  _payroll_run_id uuid,
  _payslip_id uuid,
  _kind text,
  _notes text,
  _terminal_event text,
  _terminal_end_date date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  to_status    text;
BEGIN
  IF _amount IS NULL OR _amount <= 0 THEN
    RAISE EXCEPTION 'Repayment amount must be positive.'
      USING ERRCODE='22023', HINT='LOAN_AMOUNT_INVALID';
  END IF;

  IF COALESCE(_terminal_event,'settle') NOT IN ('settle','close_on_termination') THEN
    RAISE EXCEPTION 'Unsupported terminal event: %', _terminal_event
      USING ERRCODE='22023', HINT='LOAN_TERMINAL_EVENT_INVALID';
  END IF;

  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  IF r.id IS NULL THEN
    RAISE EXCEPTION 'Loan % not found.', _loan_id
      USING ERRCODE='22023', HINT='LOAN_CONTEXT_NOT_FOUND';
  END IF;
  prior := r.status;

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

  IF COALESCE(_kind,'payroll') <> 'termination_writeoff' THEN
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
  ELSE
    -- Write-off: any pending/partial rows are cancelled — no more payments due.
    remaining := 0;
    UPDATE public.loan_repayment_schedule
       SET status='cancelled', updated_at=now()
     WHERE loan_id = _loan_id AND status IN ('pending','partial');
  END IF;

  new_repaid  := COALESCE(r.amount_repaid,0) + _amount;
  new_balance := GREATEST(COALESCE(r.total_amount,0) - new_repaid, 0);

  UPDATE public.employee_loans
     SET amount_repaid       = new_repaid,
         outstanding_balance = new_balance,
         installments_paid   = COALESCE(installments_paid,0) + 1,
         updated_at          = now()
   WHERE id = _loan_id;

  PERFORM public.loan_log_event(
    _loan_id, 'repayment_recorded', prior, prior,
    _amount, _notes,
    jsonb_build_object(
      'repayment_id',   rep_id,
      'kind',           COALESCE(_kind,'payroll'),
      'payroll_run_id', _payroll_run_id,
      'payslip_id',     _payslip_id,
      'amount_repaid',  new_repaid,
      'outstanding_balance', new_balance,
      'unallocated',    remaining,
      'terminal_event', COALESCE(_terminal_event,'settle')));

  IF prior = 'in_arrears' AND COALESCE(_terminal_event,'settle') = 'settle' THEN
    PERFORM public.employee_loan_clear_arrears(_loan_id);
  END IF;

  IF new_balance <= 0.005 THEN
    IF COALESCE(_terminal_event,'settle') = 'close_on_termination' THEN
      SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
      PERFORM public._loan_assert_transition(_loan_id, 'close_on_termination');
      to_status := 'closed_on_termination';
      UPDATE public.employee_loans
         SET status = to_status,
             end_date = COALESCE(_terminal_end_date, end_date, CURRENT_DATE),
             updated_at = now()
       WHERE id = _loan_id;
      PERFORM public.loan_log_event(
        _loan_id, 'close_on_termination', r.status, to_status,
        NULL, _notes,
        jsonb_build_object('repayment_id', rep_id, 'kind', COALESCE(_kind,'payroll')));
      completed := true;
    ELSE
      PERFORM public.employee_loan_settle(_loan_id);
      completed := true;
    END IF;
  END IF;

  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id;

  RETURN jsonb_build_object(
    'loan_id', _loan_id, 'repayment_id', rep_id,
    'status', r.status, 'outstanding_balance', r.outstanding_balance,
    'completed', completed, 'already_applied', false);
END
$function$;

REVOKE ALL ON FUNCTION public.employee_loan_apply_repayment(uuid, numeric, uuid, uuid, text, text, text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.employee_loan_apply_repayment(uuid, numeric, uuid, uuid, text, text, text, date) TO authenticated, service_role;

-- 4. Replace the legacy 6-arg overload with a thin wrapper delegating to the 8-arg form.
CREATE OR REPLACE FUNCTION public.employee_loan_apply_repayment(
  _loan_id uuid,
  _amount numeric,
  _payroll_run_id uuid DEFAULT NULL,
  _payslip_id uuid DEFAULT NULL,
  _kind text DEFAULT 'payroll',
  _notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.employee_loan_apply_repayment(
    _loan_id, _amount, _payroll_run_id, _payslip_id,
    COALESCE(_kind,'payroll'), _notes, 'settle', NULL::date);
$function$;
REVOKE ALL ON FUNCTION public.employee_loan_apply_repayment(uuid, numeric, uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.employee_loan_apply_repayment(uuid, numeric, uuid, uuid, text, text) TO authenticated, service_role;

-- 5. Canonical termination-settlement RPC.
CREATE OR REPLACE FUNCTION public.employee_loan_close_on_termination(
  _loan_id uuid,
  _termination_date date,
  _reason text DEFAULT NULL,
  _payroll_run_id uuid DEFAULT NULL,
  _payslip_id uuid DEFAULT NULL,
  _recovered_amount numeric DEFAULT 0,
  _writeoff_remaining boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r          public.employee_loans;
  prior      text;
  rec_res    jsonb;
  wo_res     jsonb;
  wo_amount  numeric;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  IF r.id IS NULL THEN
    RAISE EXCEPTION 'Loan % not found.', _loan_id
      USING ERRCODE='22023', HINT='LOAN_CONTEXT_NOT_FOUND';
  END IF;
  prior := r.status;

  IF r.status NOT IN ('active','in_arrears','paused','restructured') THEN
    RAISE EXCEPTION 'A loan in status "%" cannot be closed on termination.', r.status
      USING ERRCODE='22023', HINT='LOAN_STATE_INVALID';
  END IF;

  IF COALESCE(_recovered_amount,0) > 0 THEN
    rec_res := public.employee_loan_apply_repayment(
      _loan_id, _recovered_amount, _payroll_run_id, _payslip_id,
      'termination_recovery', COALESCE(_reason,'Recovered from final pay'),
      'close_on_termination', _termination_date);
    SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  END IF;

  IF r.outstanding_balance > 0.005 THEN
    IF _writeoff_remaining THEN
      wo_amount := r.outstanding_balance;
      wo_res := public.employee_loan_apply_repayment(
        _loan_id, wo_amount, _payroll_run_id, _payslip_id,
        'termination_writeoff', COALESCE(_reason,'Termination write-off'),
        'close_on_termination', _termination_date);
      SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id;
    ELSE
      RAISE EXCEPTION 'Loan % still has an outstanding balance of % and write-off was not authorised.',
        _loan_id, r.outstanding_balance
        USING ERRCODE='22023', HINT='LOAN_TERMINATION_UNCLEARED_BALANCE';
    END IF;
  ELSIF r.status <> 'closed_on_termination' THEN
    PERFORM public._loan_assert_transition(_loan_id, 'close_on_termination');
    UPDATE public.employee_loans
       SET status='closed_on_termination',
           end_date=COALESCE(_termination_date, end_date, CURRENT_DATE),
           updated_at=now()
     WHERE id=_loan_id;
    PERFORM public.loan_log_event(
      _loan_id, 'close_on_termination', prior, 'closed_on_termination',
      NULL, _reason,
      jsonb_build_object('payroll_run_id', _payroll_run_id, 'payslip_id', _payslip_id));
    SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id;
  END IF;

  IF r.status <> 'closed_on_termination' THEN
    RAISE EXCEPTION 'employee_loan_close_on_termination: loan % ended in status %, expected closed_on_termination',
      _loan_id, r.status
      USING ERRCODE='P0001', HINT='LOAN_TERMINATION_UNEXPECTED_STATUS';
  END IF;

  RETURN jsonb_build_object(
    'loan_id', _loan_id,
    'status', r.status,
    'outstanding_balance', r.outstanding_balance,
    'recovered', rec_res,
    'wroteoff', wo_res);
END
$function$;

REVOKE ALL ON FUNCTION public.employee_loan_close_on_termination(uuid, date, text, uuid, uuid, numeric, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.employee_loan_close_on_termination(uuid, date, text, uuid, uuid, numeric, boolean) TO authenticated, service_role;
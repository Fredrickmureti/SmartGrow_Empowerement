
-- =========================================================================
-- Phase 8 — Reverse-repayment parity (single writer)
-- =========================================================================

-- Allow the negative-amount reversal ledger row; still forbid zero.
ALTER TABLE public.loan_repayments
  DROP CONSTRAINT IF EXISTS loan_repayments_amount_check;
ALTER TABLE public.loan_repayments
  ADD CONSTRAINT loan_repayments_amount_check CHECK (amount <> 0);

-- Add a canonical 'reopen' transition so reversing the final instalment on a
-- completed loan can transition back to 'active' through the state machine.
CREATE OR REPLACE VIEW public.employee_loan_state_transitions AS
SELECT from_status, event, to_status FROM (VALUES
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
  ('suspended','cancel','cancelled'),
  ('completed','reopen','active')
) t(from_status, event, to_status);

-- Internal: de-allocate the schedule rows previously paid by _repayment_id.
-- Mirrors the FIFO allocator inside employee_loan_apply_repayment.
CREATE OR REPLACE FUNCTION public._loan_deallocate_schedule(_repayment_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.loan_repayment_schedule
     SET paid_amount = 0,
         status      = 'pending',
         payslip_id  = NULL,
         repayment_id = NULL,
         updated_at  = now()
   WHERE repayment_id = _repayment_id;
END $$;

GRANT EXECUTE ON FUNCTION public._loan_deallocate_schedule(uuid) TO service_role;

-- Canonical reversal — strict inverse of apply_repayment; no drift-prone math.
CREATE OR REPLACE FUNCTION public.employee_loan_reverse_repayment(
  _repayment_id uuid,
  _reason       text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  orig        public.loan_repayments;
  r           public.employee_loans;
  rev_id      uuid;
  v_number    text;
  v_je_id     uuid;
  v_lines     jsonb;
  agg_repaid  numeric;
  agg_count   integer;
  new_balance numeric;
  prior       text;
  reopened    boolean := false;
BEGIN
  SELECT * INTO orig FROM public.loan_repayments
    WHERE id = _repayment_id FOR UPDATE;
  IF orig.id IS NULL THEN
    RAISE EXCEPTION 'Repayment % not found.', _repayment_id
      USING ERRCODE='22023', HINT='LOAN_REPAYMENT_NOT_FOUND';
  END IF;
  IF orig.kind = 'reversal' THEN
    RAISE EXCEPTION 'Cannot reverse a reversal.'
      USING ERRCODE='22023', HINT='LOAN_REVERSAL_INVALID';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.loan_repayments
      WHERE reversal_of_id = orig.id
  ) THEN
    RAISE EXCEPTION 'Repayment % has already been reversed.', _repayment_id
      USING ERRCODE='22023', HINT='LOAN_REVERSAL_DUPLICATE';
  END IF;

  SELECT * INTO r FROM public.employee_loans
    WHERE id = orig.loan_id FOR UPDATE;
  IF r.status = 'archived' THEN
    RAISE EXCEPTION 'Cannot reverse a repayment on an archived loan.'
      USING ERRCODE='22023', HINT='LOAN_STATE_INVALID';
  END IF;
  prior := r.status;

  -- 1. Audit trail: the negative ledger row.
  INSERT INTO public.loan_repayments(
    loan_id, amount, repayment_date, installment_number, notes, kind,
    reversal_of_id, created_by)
  VALUES (
    orig.loan_id, -orig.amount, CURRENT_DATE, 0,
    COALESCE(_reason,'reversal'), 'reversal', orig.id, auth.uid())
  RETURNING id INTO rev_id;

  -- 2. Finance mirror JE (unchanged — Finance owns posting).
  IF orig.journal_entry_id IS NOT NULL THEN
    SELECT jsonb_agg(jsonb_build_object(
             'account_id',  l.account_id,
             'debit',       l.credit,
             'credit',      l.debit,
             'description', 'Reversal — ' || COALESCE(l.description, r.loan_number)))
      INTO v_lines
      FROM public.journal_entry_lines l
     WHERE l.journal_entry_id = orig.journal_entry_id;

    IF v_lines IS NOT NULL AND jsonb_array_length(v_lines) >= 2 THEN
      v_number := public.generate_next_je_number(r.organization_id, r.business_id);
      v_je_id := public.post_journal_entry_atomic(
        _org_id       => r.organization_id,
        _business_id  => r.business_id,
        _entry_number => v_number,
        _entry_date   => CURRENT_DATE,
        _reference    => r.loan_number,
        _description  => 'Employee loan ' || r.loan_number || ' (repayment reversal)',
        _source_type  => 'loan_repayment_reversal',
        _source_id    => rev_id,
        _created_by   => auth.uid(),
        _is_closing   => false,
        _is_adjusting => false,
        _lines        => v_lines,
        _branch_id    => NULL
      );
      UPDATE public.loan_repayments SET journal_entry_id = v_je_id WHERE id = rev_id;
    END IF;
  END IF;

  -- 3. De-allocate schedule rows that the original repayment had paid.
  PERFORM public._loan_deallocate_schedule(orig.id);

  -- 4. Recompute balances from the immutable ledger (no in-place drift).
  SELECT COALESCE(SUM(amount), 0),
         COALESCE(COUNT(*) FILTER (WHERE amount > 0 AND kind <> 'reversal'
                                     AND NOT EXISTS (
                                       SELECT 1 FROM public.loan_repayments r2
                                        WHERE r2.reversal_of_id = lr.id)), 0)
    INTO agg_repaid, agg_count
    FROM public.loan_repayments lr
   WHERE lr.loan_id = orig.loan_id;

  new_balance := GREATEST(COALESCE(r.total_amount,0) - agg_repaid, 0);

  -- 5. Reopen the loan if the reversal brings a completed loan back to life.
  IF prior = 'completed' AND new_balance > 0.005 THEN
    PERFORM public._loan_assert_transition(orig.loan_id, 'reopen');
    UPDATE public.employee_loans
       SET status              = 'active',
           amount_repaid       = agg_repaid,
           outstanding_balance = new_balance,
           installments_paid   = agg_count,
           updated_at          = now()
     WHERE id = orig.loan_id;
    reopened := true;
  ELSE
    UPDATE public.employee_loans
       SET amount_repaid       = agg_repaid,
           outstanding_balance = new_balance,
           installments_paid   = agg_count,
           updated_at          = now()
     WHERE id = orig.loan_id;
  END IF;

  PERFORM public.loan_log_event(
    orig.loan_id, 'reverse_repayment',
    prior, CASE WHEN reopened THEN 'active' ELSE prior END,
    orig.amount, _reason,
    jsonb_build_object(
      'repayment_id',     orig.id,
      'reversal_id',      rev_id,
      'journal_entry_id', v_je_id,
      'amount_repaid',    agg_repaid,
      'outstanding_balance', new_balance,
      'reopened',         reopened));

  RETURN rev_id;
END $$;

GRANT EXECUTE ON FUNCTION public.employee_loan_reverse_repayment(uuid, text)
  TO authenticated, service_role;


-- =========================================================================
-- Phase 7 — Arrears detection (scheduled)
-- =========================================================================

-- Promote every 'active' loan with an overdue pending/partial instalment to
-- 'in_arrears' through the state machine. Idempotent — no-ops if a loan is
-- already in_arrears. Runs daily via pg_cron.
CREATE OR REPLACE FUNCTION public.employee_loan_mark_missed_installments(
  _as_of date DEFAULT CURRENT_DATE
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_loan       record;
  v_missed_ids uuid[];
  v_promoted   integer := 0;
  v_scanned    integer := 0;
BEGIN
  FOR v_loan IN
    SELECT el.id AS loan_id, el.status
      FROM public.employee_loans el
     WHERE el.status = 'active'
       AND EXISTS (
         SELECT 1
           FROM public.loan_repayment_schedule s
          WHERE s.loan_id = el.id
            AND s.due_date < _as_of
            AND s.status IN ('pending','partial')
       )
     FOR UPDATE
  LOOP
    v_scanned := v_scanned + 1;
    SELECT array_agg(s.id ORDER BY s.due_date)
      INTO v_missed_ids
      FROM public.loan_repayment_schedule s
     WHERE s.loan_id = v_loan.loan_id
       AND s.due_date < _as_of
       AND s.status IN ('pending','partial');

    -- Route through the state machine. If the transition is invalid (e.g.
    -- another writer moved the loan in the same tx) skip and continue.
    BEGIN
      PERFORM public._loan_assert_transition(v_loan.loan_id, 'enter_arrears');
    EXCEPTION WHEN OTHERS THEN
      CONTINUE;
    END;

    UPDATE public.employee_loans
       SET status        = 'in_arrears',
           arrears_since = COALESCE(arrears_since, _as_of),
           updated_at    = now()
     WHERE id = v_loan.loan_id;

    PERFORM public.loan_log_event(
      v_loan.loan_id, 'enter_arrears', v_loan.status, 'in_arrears',
      NULL, 'Overdue scheduled instalment detected by sweep',
      jsonb_build_object(
        'as_of',        _as_of,
        'missed_ids',   to_jsonb(v_missed_ids),
        'missed_count', array_length(v_missed_ids, 1)));
    v_promoted := v_promoted + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'as_of',    _as_of,
    'scanned',  v_scanned,
    'promoted', v_promoted);
END $$;

GRANT EXECUTE ON FUNCTION public.employee_loan_mark_missed_installments(date)
  TO service_role;

-- Daily sweep at 02:15 UTC. Idempotent — safe to re-schedule.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
      FROM cron.job WHERE jobname = 'employee-loan-arrears-sweep';
    PERFORM cron.schedule(
      'employee-loan-arrears-sweep',
      '15 2 * * *',
      $sql$ SELECT public.employee_loan_mark_missed_installments(CURRENT_DATE); $sql$
    );
  END IF;
END $$;

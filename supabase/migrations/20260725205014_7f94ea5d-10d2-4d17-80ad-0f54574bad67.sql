-- ============================================================
-- Phase L1 — state machine hardening
-- ============================================================

-- 1. Loan audit columns for the authorisation control gate
ALTER TABLE public.employee_loans
  ADD COLUMN IF NOT EXISTS authorized_by uuid,
  ADD COLUMN IF NOT EXISTS authorized_at timestamptz,
  ADD COLUMN IF NOT EXISTS disbursement_bank_account_id uuid;

-- 2. Canonical transition catalogue (one row per legal move)
CREATE OR REPLACE VIEW public.employee_loan_state_transitions AS
SELECT * FROM (VALUES
  ('draft',                 'submit',                    'pending_approval'),
  ('requested',             'submit',                    'pending_approval'),
  ('rejected',              'submit',                    'pending_approval'),
  ('pending_approval',      'approve',                   'approved'),
  ('pending_approval',      'reject',                    'rejected'),
  ('pending_approval',      'cancel',                    'cancelled'),
  ('approved',              'authorize_disbursement',    'awaiting_disbursement'),
  ('approved',              'cancel',                    'cancelled'),
  ('awaiting_disbursement', 'disburse',                  'active'),
  ('awaiting_disbursement', 'cancel_authorization',      'approved'),
  ('awaiting_disbursement', 'cancel',                    'cancelled'),
  ('awaiting_disbursement', 'suspend',                   'suspended'),
  ('active',                'enter_arrears',             'in_arrears'),
  ('active',                'pause',                     'paused'),
  ('active',                'suspend',                   'suspended'),
  ('active',                'settle',                    'settled'),
  ('active',                'write_off',                 'written_off'),
  ('active',                'restructure',               'restructured'),
  ('active',                'close_on_termination',      'closed_on_termination'),
  ('in_arrears',            'exit_arrears',              'active'),
  ('in_arrears',            'pause',                     'paused'),
  ('in_arrears',            'settle',                    'settled'),
  ('in_arrears',            'write_off',                 'written_off'),
  ('in_arrears',            'restructure',               'restructured'),
  ('in_arrears',            'close_on_termination',      'closed_on_termination'),
  ('paused',                'resume',                    'active'),
  ('paused',                'write_off',                 'written_off'),
  ('paused',                'restructure',               'restructured'),
  ('paused',                'close_on_termination',      'closed_on_termination'),
  ('suspended',             'resume',                    'active'),
  ('suspended',             'cancel',                    'cancelled')
) AS t(from_status, event, to_status);

GRANT SELECT ON public.employee_loan_state_transitions TO authenticated, service_role;

-- 3. Assertion helper — locks the row, validates the move, returns it.
CREATE OR REPLACE FUNCTION public._loan_assert_transition(_loan_id uuid, _event text)
RETURNS public.employee_loans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r public.employee_loans; v_to text;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id = _loan_id FOR UPDATE;
  IF r.id IS NULL THEN
    RAISE EXCEPTION 'Loan not found.'
      USING ERRCODE = '22023', HINT = 'LOAN_CONTEXT_NOT_FOUND';
  END IF;
  SELECT to_status INTO v_to
    FROM public.employee_loan_state_transitions
   WHERE from_status = r.status AND event = _event
   LIMIT 1;
  IF v_to IS NULL THEN
    RAISE EXCEPTION 'Loan in status "%" cannot undergo event "%".', r.status, _event
      USING ERRCODE = '22023', HINT = 'LOAN_STATE_INVALID';
  END IF;
  RETURN r;
END $$;

REVOKE ALL ON FUNCTION public._loan_assert_transition(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._loan_assert_transition(uuid, text) TO authenticated, service_role;

-- ============================================================
-- Phase L5 — outbox fan-out for every lifecycle event
-- ============================================================

-- 4. Extend the single-writer logger to publish to business_event_outbox.
--    Every existing RPC (approve, authorize, disburse, settle, write_off,
--    restructure, pause/resume, arrears, manual repayment, ...) calls
--    loan_log_event, so this one change fans them all out uniformly.
CREATE OR REPLACE FUNCTION public.loan_log_event(
  _loan_id       uuid,
  _event_type    text,
  _prior_status  text,
  _new_status    text,
  _amount        numeric DEFAULT NULL,
  _reason        text    DEFAULT NULL,
  _payload       jsonb   DEFAULT '{}'::jsonb,
  _cosigner      uuid    DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org      uuid;
  _biz      uuid;
  _branch   uuid;
  _id       uuid;
  _payload2 jsonb;
BEGIN
  SELECT organization_id, business_id, branch_id
    INTO _org, _biz, _branch
    FROM public.employee_loans WHERE id = _loan_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'loan not found: %', _loan_id; END IF;

  INSERT INTO public.loan_lifecycle_events(
    organization_id, loan_id, event_type, prior_status, new_status,
    amount, reason, payload, actor_user_id, cosigner_user_id
  ) VALUES (
    _org, _loan_id, _event_type, _prior_status, _new_status,
    _amount, _reason, COALESCE(_payload, '{}'::jsonb),
    auth.uid(), _cosigner
  ) RETURNING id INTO _id;

  -- Fan out (best-effort — a broken outbox must not roll back the RPC).
  BEGIN
    _payload2 := COALESCE(_payload, '{}'::jsonb)
              || jsonb_build_object(
                   'loan_id',       _loan_id,
                   'prior_status',  _prior_status,
                   'new_status',    _new_status,
                   'amount',        _amount,
                   'reason',        _reason,
                   'cosigner',      _cosigner,
                   'event_id',      _id
                 );
    INSERT INTO public.business_event_outbox(
      org_id, branch_id, event_type, source_doc_type, source_doc_id,
      payload, status, actor_user_id, idempotency_key, source
    ) VALUES (
      _org, _branch, 'loan.' || _event_type, 'employee_loan', _loan_id,
      _payload2, 'pending', auth.uid(),
      'loan:' || _loan_id::text || ':' || _id::text,
      'employee_loan_lifecycle'
    );
  EXCEPTION WHEN OTHERS THEN
    -- Never fail the lifecycle RPC because of a bad outbox row; record it.
    RAISE WARNING 'loan_log_event outbox emit failed for loan % event %: %',
      _loan_id, _event_type, SQLERRM;
  END;

  RETURN _id;
END $$;

-- ============================================================
-- Wire authorise + disburse into the state machine and audit columns
-- ============================================================

CREATE OR REPLACE FUNCTION public.employee_loan_authorize_disbursement(_loan_id uuid)
RETURNS public.employee_loans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r public.employee_loans; prior text;
BEGIN
  r     := public._loan_assert_transition(_loan_id, 'authorize_disbursement');
  prior := r.status;

  PERFORM public.governance_assert_not_self(
    auth.uid(), COALESCE(r.approved_by, r.requested_by, r.created_by),
    'employee_loan.authorize_disbursement',
    r.organization_id, 'employee_loan', _loan_id
  );

  UPDATE public.employee_loans
     SET status        = 'awaiting_disbursement',
         authorized_by = auth.uid(),
         authorized_at = now(),
         updated_at    = now()
   WHERE id = _loan_id
   RETURNING * INTO r;

  PERFORM public.loan_log_event(
    _loan_id, 'authorize_disbursement', prior, 'awaiting_disbursement'
  );
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.employee_loan_disburse(
  _loan_id uuid, _bank_account_id uuid, _value_date date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r            public.employee_loans;
  v_receivable uuid;
  v_amount     numeric;
  v_je_id      uuid;
  v_entry_date date;
  prior        text;
BEGIN
  -- Lock first so the idempotency check races safely.
  SELECT * INTO r FROM public.employee_loans WHERE id = _loan_id FOR UPDATE;
  IF r.id IS NULL THEN
    RAISE EXCEPTION 'Loan not found.'
      USING ERRCODE='22023', HINT='LOAN_CONTEXT_NOT_FOUND';
  END IF;
  IF r.disbursement_journal_entry_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'journal_entry_id', r.disbursement_journal_entry_id,
      'idempotent', true, 'status', r.status);
  END IF;

  -- Enforce the state machine (approved → authorize → disburse).
  PERFORM public._loan_assert_transition(_loan_id, 'disburse');
  prior := r.status;

  IF _bank_account_id IS NULL THEN
    RAISE EXCEPTION 'Bank/cash account is required for disbursement.'
      USING ERRCODE='22023', HINT='LOAN_BANK_REQUIRED';
  END IF;

  v_receivable := public._loan_resolve_account(
    r.organization_id, r.business_id, r.branch_id, 'loan_receivable',
    (SELECT gl_receivable_account_id FROM public.loan_types WHERE id = r.loan_type_id)
  );
  IF v_receivable IS NULL THEN
    RAISE EXCEPTION 'Loan Receivable account is not mapped. Configure it under Finance → Default Accounts (loan_receivable).'
      USING ERRCODE='22023', HINT='LOAN_ACCOUNT_UNMAPPED';
  END IF;

  v_amount := COALESCE(r.principal_amount, 0);
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Loan principal must be greater than zero.'
      USING ERRCODE='22023', HINT='LOAN_PRINCIPAL_INVALID';
  END IF;
  v_entry_date := COALESCE(_value_date, CURRENT_DATE);

  INSERT INTO public.journal_entries(
    organization_id, business_id, branch_id, entry_date,
    description, reference, status, posted_at, posted_by,
    source_type, source_id, total_debit, total_credit, created_by
  ) VALUES (
    r.organization_id, r.business_id, r.branch_id, v_entry_date,
    'Loan disbursement — ' || r.loan_number, r.loan_number,
    'posted', now(), auth.uid(),
    'loan_disbursement', r.id, v_amount, v_amount, auth.uid()
  ) RETURNING id INTO v_je_id;

  INSERT INTO public.journal_entry_lines(
    journal_entry_id, account_id, debit, credit, description,
    sort_order, business_id, branch_id
  ) VALUES
    (v_je_id, v_receivable,     v_amount, 0,
     'Loan receivable — '   || r.loan_number, 1, r.business_id, r.branch_id),
    (v_je_id, _bank_account_id, 0, v_amount,
     'Bank disbursement — ' || r.loan_number, 2, r.business_id, r.branch_id);

  UPDATE public.employee_loans
     SET status                          = 'active',
         disbursed_at                    = COALESCE(disbursed_at, now()),
         disbursement_journal_entry_id   = v_je_id,
         disbursement_bank_account_id    = _bank_account_id,
         updated_at                      = now()
   WHERE id = r.id;

  PERFORM public.loan_log_event(
    r.id, 'disburse', prior, 'active', v_amount, NULL,
    jsonb_build_object(
      'journal_entry_id', v_je_id,
      'bank_account_id',  _bank_account_id,
      'value_date',       v_entry_date)
  );

  RETURN jsonb_build_object('journal_entry_id', v_je_id, 'idempotent', false, 'status', 'active');
END $$;

-- ============================================================
-- Phase L5 — finance integrity: Loan Receivable vs sum(outstanding)
-- ============================================================

CREATE OR REPLACE FUNCTION public.finance_loan_receivable_integrity_check(_org uuid)
RETURNS TABLE(loans_outstanding numeric, gl_balance numeric, drift numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_receivable uuid;
  v_gl         numeric;
  v_loans      numeric;
  v_drift      numeric;
BEGIN
  v_receivable := public._loan_resolve_account(_org, NULL, NULL, 'loan_receivable', NULL);
  IF v_receivable IS NULL THEN
    RETURN QUERY SELECT 0::numeric, 0::numeric, 0::numeric;
    RETURN;
  END IF;

  SELECT COALESCE(SUM(l.debit - l.credit), 0) INTO v_gl
    FROM public.journal_entry_lines l
    JOIN public.journal_entries j ON j.id = l.journal_entry_id
   WHERE l.account_id = v_receivable
     AND j.organization_id = _org
     AND j.status = 'posted';

  SELECT COALESCE(SUM(outstanding_balance), 0) INTO v_loans
    FROM public.employee_loans
   WHERE organization_id = _org
     AND status IN ('active','in_arrears','paused','suspended','awaiting_disbursement');

  v_drift := v_gl - v_loans;

  IF ABS(v_drift) > 0.01 THEN
    INSERT INTO public.finance_integrity_issues(
      organization_id, issue_code, severity, source_type, source_id, details
    ) VALUES (
      _org, 'LOAN_RECEIVABLE_DRIFT', 'high', 'employee_loans', NULL,
      jsonb_build_object(
        'gl_balance', v_gl,
        'loans_outstanding', v_loans,
        'drift', v_drift,
        'checked_at', now())
    );
  END IF;

  RETURN QUERY SELECT v_loans, v_gl, v_drift;
END $$;

REVOKE ALL ON FUNCTION public.finance_loan_receivable_integrity_check(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finance_loan_receivable_integrity_check(uuid) TO service_role;
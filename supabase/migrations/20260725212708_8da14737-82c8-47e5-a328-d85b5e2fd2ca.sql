-- =====================================================================
-- Loan lifecycle → canonical Finance posting engine consolidation
--
-- Root cause of `23502 entry_number` on employee_loan_disburse:
-- the loan module hand-rolled an INSERT INTO journal_entries instead of
-- calling post_journal_entry_atomic + generate_next_je_number. Numbering
-- is owned by the Finance engine; Loans must never post directly.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helper: bank ledger movement for a loan cash event.
-- Resolves the bank_accounts row that maps to the GL cash account and
-- writes a bank_transactions line. Deterministic external id gives
-- retry idempotency via (bank_account_id, external_transaction_id).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._loan_record_bank_movement(
  _org uuid,
  _business uuid,
  _branch uuid,
  _gl_account_id uuid,
  _amount numeric,
  _direction text,          -- 'out' (disbursement) | 'in' (repayment)
  _value_date date,
  _reference text,
  _description text,
  _je_id uuid,
  _external_key text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_bank uuid;
  v_id   uuid;
BEGIN
  SELECT id INTO v_bank
    FROM public.bank_accounts
   WHERE organization_id = _org
     AND business_id     = _business
     AND account_id      = _gl_account_id
     AND COALESCE(is_active, true)
   ORDER BY is_primary DESC NULLS LAST
   LIMIT 1;

  -- Petty-cash / GL-only accounts have no bank ledger. That is legitimate;
  -- the journal entry is still the accounting record of truth.
  IF v_bank IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.bank_transactions(
    organization_id, business_id, branch_id, bank_account_id,
    external_transaction_id, transaction_date, posting_date,
    description, reference, amount, transaction_type,
    journal_entry_id, lifecycle_status, is_reconciled
  ) VALUES (
    _org, _business, _branch, v_bank,
    _external_key, _value_date, _value_date,
    _description, _reference,
    CASE WHEN _direction = 'out' THEN -ABS(_amount) ELSE ABS(_amount) END,
    CASE WHEN _direction = 'out' THEN 'debit' ELSE 'credit' END,
    _je_id, 'posted', false
  )
  ON CONFLICT (bank_account_id, external_transaction_id) DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END $function$;

-- ---------------------------------------------------------------------
-- Helper: principal / interest split of a repayment amount.
-- Receivable was debited with principal only at disbursement, while
-- outstanding_balance tracks principal + interest. Split pro-rata so the
-- receivable unwinds to zero and interest lands in income.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._loan_split_repayment(
  _loan_id uuid,
  _amount  numeric,
  OUT o_principal numeric,
  OUT o_interest  numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r public.employee_loans;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id = _loan_id;
  IF r.id IS NULL OR COALESCE(r.total_amount, 0) <= 0
     OR COALESCE(r.principal_amount, 0) >= COALESCE(r.total_amount, 0) THEN
    o_principal := _amount;
    o_interest  := 0;
    RETURN;
  END IF;
  o_principal := ROUND(_amount * (r.principal_amount / r.total_amount), 2);
  o_interest  := ROUND(_amount - o_principal, 2);
END $function$;

-- =====================================================================
-- PHASE 1 + 2 — Disbursement through the Finance engine + bank movement
-- =====================================================================
CREATE OR REPLACE FUNCTION public.employee_loan_disburse(
  _loan_id uuid,
  _bank_account_id uuid,
  _value_date date DEFAULT NULL::date
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r            public.employee_loans;
  v_receivable uuid;
  v_amount     numeric;
  v_je_id      uuid;
  v_entry_date date;
  v_number     text;
  prior        text;
BEGIN
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

  PERFORM public._loan_assert_transition(_loan_id, 'disburse');
  prior := r.status;

  IF _bank_account_id IS NULL THEN
    RAISE EXCEPTION 'Bank/cash account is required for disbursement.'
      USING ERRCODE='22023', HINT='LOAN_BANK_REQUIRED';
  END IF;

  v_receivable := public._loan_resolve_account(
    r.organization_id, r.business_id, NULL, 'loan_receivable',
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

  -- Journal identity is owned by the Finance numbering engine.
  v_number := public.generate_next_je_number(r.organization_id, r.business_id);

  -- Posting is owned by the canonical Finance engine: balance validation,
  -- header totals, org/business/branch stamping, and source-key
  -- idempotency all live there (ADR-0020 narration: human doc number).
  v_je_id := public.post_journal_entry_atomic(
    _org_id       => r.organization_id,
    _business_id  => r.business_id,
    _entry_number => v_number,
    _entry_date   => v_entry_date,
    _reference    => r.loan_number,
    _description  => 'Employee loan ' || r.loan_number || ' (disbursement)',
    _source_type  => 'loan_disbursement',
    _source_id    => r.id,
    _created_by   => auth.uid(),
    _is_closing   => false,
    _is_adjusting => false,
    _lines        => jsonb_build_array(
      jsonb_build_object(
        'account_id',  v_receivable,
        'debit',       v_amount,
        'credit',      0,
        'description', 'Loan receivable — ' || r.loan_number),
      jsonb_build_object(
        'account_id',  _bank_account_id,
        'debit',       0,
        'credit',      v_amount,
        'description', 'Bank disbursement — ' || r.loan_number)
    ),
    _branch_id    => NULL
  );

  PERFORM public._loan_record_bank_movement(
    r.organization_id, r.business_id, NULL, _bank_account_id,
    v_amount, 'out', v_entry_date, r.loan_number,
    'Employee loan ' || r.loan_number || ' (disbursement)',
    v_je_id, 'loan-disb:' || r.id::text);

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
      'entry_number',     v_number,
      'bank_account_id',  _bank_account_id,
      'value_date',       v_entry_date)
  );

  RETURN jsonb_build_object(
    'journal_entry_id', v_je_id, 'entry_number', v_number,
    'idempotent', false, 'status', 'active');
END $function$;

-- =====================================================================
-- PHASE 3 — Repayment / reversal / write-off GL through the same engine
-- =====================================================================
CREATE OR REPLACE FUNCTION public.employee_loan_record_manual_repayment(
  _loan_id uuid,
  _amount numeric,
  _repayment_date date,
  _notes text DEFAULT NULL::text,
  _bank_account_id uuid DEFAULT NULL::uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r            public.employee_loans;
  lt           public.loan_types;
  rep_id       uuid;
  next_seq     integer;
  v_bank_gl    uuid;
  v_receivable uuid;
  v_interest   uuid;
  v_principal  numeric;
  v_int_amt    numeric;
  v_number     text;
  v_je_id      uuid;
  v_lines      jsonb;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'loan not found'; END IF;
  IF r.status NOT IN ('active','in_arrears','paused','restructured') THEN
    RAISE EXCEPTION 'cannot record repayment in status %', r.status;
  END IF;
  IF _amount <= 0 THEN RAISE EXCEPTION 'amount must be positive'; END IF;
  PERFORM public.governance_assert_not_self(
    auth.uid(), COALESCE(r.requested_by, r.created_by),
    'employee_loan.record_manual_repayment',
    r.organization_id, 'employee_loan', _loan_id
  );

  SELECT * INTO lt FROM public.loan_types WHERE id = r.loan_type_id;

  v_receivable := public._loan_resolve_account(
    r.organization_id, r.business_id, NULL, 'loan_receivable',
    lt.gl_receivable_account_id);
  IF v_receivable IS NULL THEN
    RAISE EXCEPTION 'Loan Receivable account is not mapped. Configure it under Finance → Default Accounts (loan_receivable).'
      USING ERRCODE='22023', HINT='LOAN_ACCOUNT_UNMAPPED';
  END IF;

  v_bank_gl := COALESCE(
    _bank_account_id,
    public._loan_resolve_account(r.organization_id, r.business_id, NULL, 'bank', NULL),
    public._loan_resolve_account(r.organization_id, r.business_id, NULL, 'cash', NULL),
    r.disbursement_bank_account_id);
  IF v_bank_gl IS NULL THEN
    RAISE EXCEPTION 'A bank/cash account is required to post a manual repayment.'
      USING ERRCODE='22023', HINT='LOAN_BANK_REQUIRED';
  END IF;

  SELECT COALESCE(MAX(installment_number),0)+1 INTO next_seq
    FROM public.loan_repayments WHERE loan_id=_loan_id;

  INSERT INTO public.loan_repayments(loan_id, amount, repayment_date, installment_number, notes, kind, created_by)
    VALUES (_loan_id, _amount, _repayment_date, next_seq, _notes, 'manual', auth.uid())
    RETURNING id INTO rep_id;

  SELECT o_principal, o_interest INTO v_principal, v_int_amt
    FROM public._loan_split_repayment(_loan_id, _amount);

  v_interest := CASE
    WHEN v_int_amt > 0 THEN public._loan_resolve_account(
      r.organization_id, r.business_id, NULL, 'interest_income',
      lt.interest_income_account_id)
    ELSE NULL END;

  -- No interest income account configured → recover the full amount
  -- against the receivable rather than posting to a guessed account.
  IF v_int_amt > 0 AND v_interest IS NULL THEN
    v_principal := _amount;
    v_int_amt   := 0;
  END IF;

  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', v_bank_gl, 'debit', _amount, 'credit', 0,
      'description', 'Loan repayment received — ' || r.loan_number),
    jsonb_build_object('account_id', v_receivable, 'debit', 0, 'credit', v_principal,
      'description', 'Loan receivable recovery — ' || r.loan_number));
  IF v_int_amt > 0 THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_interest, 'debit', 0, 'credit', v_int_amt,
        'description', 'Loan interest income — ' || r.loan_number));
  END IF;

  v_number := public.generate_next_je_number(r.organization_id, r.business_id);
  v_je_id := public.post_journal_entry_atomic(
    _org_id       => r.organization_id,
    _business_id  => r.business_id,
    _entry_number => v_number,
    _entry_date   => _repayment_date,
    _reference    => r.loan_number,
    _description  => 'Employee loan ' || r.loan_number || ' (manual repayment)',
    _source_type  => 'loan_repayment',
    _source_id    => rep_id,
    _created_by   => auth.uid(),
    _is_closing   => false,
    _is_adjusting => false,
    _lines        => v_lines,
    _branch_id    => NULL
  );

  UPDATE public.loan_repayments SET journal_entry_id = v_je_id WHERE id = rep_id;

  PERFORM public._loan_record_bank_movement(
    r.organization_id, r.business_id, NULL, v_bank_gl,
    _amount, 'in', _repayment_date, r.loan_number,
    'Employee loan ' || r.loan_number || ' (repayment)',
    v_je_id, 'loan-repay:' || rep_id::text);

  UPDATE public.employee_loans
    SET amount_repaid = amount_repaid + _amount,
        outstanding_balance = GREATEST(0, outstanding_balance - _amount),
        installments_paid = installments_paid + 1, updated_at = now()
    WHERE id = _loan_id;

  PERFORM public.loan_log_event(_loan_id,'record_manual_repayment',r.status,r.status,_amount,_notes,
    jsonb_build_object('repayment_id',rep_id,'journal_entry_id',v_je_id,'entry_number',v_number));
  RETURN rep_id;
END $function$;

DROP FUNCTION IF EXISTS public.employee_loan_record_manual_repayment(uuid, numeric, date, text);

CREATE OR REPLACE FUNCTION public.employee_loan_reverse_repayment(
  _repayment_id uuid,
  _reason text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  orig     public.loan_repayments;
  r        public.employee_loans;
  rev_id   uuid;
  v_number text;
  v_je_id  uuid;
  v_lines  jsonb;
  v_line   record;
BEGIN
  SELECT * INTO orig FROM public.loan_repayments WHERE id=_repayment_id FOR UPDATE;
  IF orig.id IS NULL THEN RAISE EXCEPTION 'repayment not found'; END IF;
  IF orig.kind = 'reversal' THEN RAISE EXCEPTION 'cannot reverse a reversal'; END IF;

  SELECT * INTO r FROM public.employee_loans WHERE id = orig.loan_id FOR UPDATE;

  INSERT INTO public.loan_repayments(loan_id, amount, repayment_date, installment_number, notes, kind, reversal_of_id, created_by)
    VALUES (orig.loan_id, -orig.amount, CURRENT_DATE, 0, COALESCE(_reason,'reversal'), 'reversal', orig.id, auth.uid())
    RETURNING id INTO rev_id;

  -- Mirror the original entry with debits/credits swapped. Posted entries
  -- are immutable; correction is always a new entry.
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

  UPDATE public.employee_loans
    SET amount_repaid = GREATEST(0, amount_repaid - orig.amount),
        outstanding_balance = outstanding_balance + orig.amount,
        installments_paid = GREATEST(0, installments_paid - 1), updated_at = now()
    WHERE id = orig.loan_id;

  IF orig.payslip_id IS NOT NULL THEN
    UPDATE public.loan_repayment_schedule
      SET status='pending', paid_amount=0, payslip_id=NULL, repayment_id=NULL, updated_at=now()
      WHERE loan_id=orig.loan_id AND repayment_id=orig.id;
  END IF;

  PERFORM public.loan_log_event(orig.loan_id,'reverse_repayment',NULL,NULL,orig.amount,_reason,
    jsonb_build_object('repayment_id',orig.id,'reversal_id',rev_id,'journal_entry_id',v_je_id));
  RETURN rev_id;
END $function$;

CREATE OR REPLACE FUNCTION public.employee_loan_write_off(
  _loan_id uuid,
  _reason text,
  _cosigner uuid
) RETURNS employee_loans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r            public.employee_loans;
  prior        text;
  lt           public.loan_types;
  v_receivable uuid;
  v_expense    uuid;
  v_amount     numeric;
  v_number     text;
  v_je_id      uuid;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'loan not found'; END IF;
  prior := r.status;
  IF prior NOT IN ('active','in_arrears','paused','restructured','defaulted','closed_on_termination') THEN
    RAISE EXCEPTION 'cannot write-off loan in status %', prior;
  END IF;
  IF _cosigner IS NULL OR _cosigner = auth.uid() THEN
    RAISE EXCEPTION 'write-off requires a distinct co-signer (dual control)';
  END IF;
  PERFORM public.governance_assert_not_self(
    auth.uid(), COALESCE(r.requested_by, r.created_by),
    'employee_loan.write_off',
    r.organization_id, 'employee_loan', _loan_id
  );
  SELECT * INTO lt FROM public.loan_types WHERE id=r.loan_type_id;
  IF COALESCE(lt.dual_control_writeoff, true) AND _cosigner = r.approved_by THEN
    RAISE EXCEPTION 'co-signer must differ from approver under dual control';
  END IF;

  -- Derecognise the remaining principal exposure against bad debt.
  SELECT o_principal INTO v_amount
    FROM public._loan_split_repayment(_loan_id, COALESCE(r.outstanding_balance, 0));

  IF COALESCE(v_amount, 0) > 0 THEN
    v_receivable := public._loan_resolve_account(
      r.organization_id, r.business_id, NULL, 'loan_receivable', lt.gl_receivable_account_id);
    v_expense := public._loan_resolve_account(
      r.organization_id, r.business_id, NULL, 'bad_debt_expense', lt.writeoff_account_id);
    IF v_receivable IS NULL OR v_expense IS NULL THEN
      RAISE EXCEPTION 'Write-off needs a Loan Receivable and a write-off/bad-debt account mapped (Finance → Default Accounts, or on the loan type).'
        USING ERRCODE='22023', HINT='LOAN_ACCOUNT_UNMAPPED';
    END IF;

    v_number := public.generate_next_je_number(r.organization_id, r.business_id);
    v_je_id := public.post_journal_entry_atomic(
      _org_id       => r.organization_id,
      _business_id  => r.business_id,
      _entry_number => v_number,
      _entry_date   => CURRENT_DATE,
      _reference    => r.loan_number,
      _description  => 'Employee loan ' || r.loan_number || ' (write-off)',
      _source_type  => 'loan_write_off',
      _source_id    => r.id,
      _created_by   => auth.uid(),
      _is_closing   => false,
      _is_adjusting => false,
      _lines        => jsonb_build_array(
        jsonb_build_object('account_id', v_expense, 'debit', v_amount, 'credit', 0,
          'description', 'Loan write-off — ' || r.loan_number),
        jsonb_build_object('account_id', v_receivable, 'debit', 0, 'credit', v_amount,
          'description', 'Loan receivable derecognition — ' || r.loan_number)),
      _branch_id    => NULL
    );
  END IF;

  UPDATE public.employee_loans
    SET status='written_off', writeoff_at=now(), writeoff_by=auth.uid(),
        writeoff_cosigner_id=_cosigner, writeoff_reason=_reason,
        writeoff_journal_entry_id=COALESCE(v_je_id, writeoff_journal_entry_id),
        updated_at=now()
    WHERE id=_loan_id RETURNING * INTO r;

  PERFORM public.loan_log_event(_loan_id,'write_off',prior,'written_off',r.outstanding_balance,_reason,
    jsonb_build_object('cosigner',_cosigner,'journal_entry_id',v_je_id),_cosigner);
  RETURN r;
END $function$;

-- =====================================================================
-- PHASE 5 — Integrity check on a principal basis (GL holds principal only)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.finance_loan_receivable_integrity_check(_org uuid)
RETURNS TABLE(loans_outstanding numeric, gl_balance numeric, drift numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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

  -- Ledger carries principal exposure only; outstanding_balance includes
  -- unearned interest, so compare on a principal basis.
  SELECT COALESCE(SUM(
           CASE WHEN COALESCE(total_amount,0) > 0
                THEN ROUND(outstanding_balance * (principal_amount / total_amount), 2)
                ELSE outstanding_balance END), 0)
    INTO v_loans
    FROM public.employee_loans
   WHERE organization_id = _org
     AND status IN ('active','in_arrears','paused','suspended','restructured');

  v_drift := v_gl - v_loans;

  IF ABS(v_drift) > 0.01 THEN
    INSERT INTO public.finance_integrity_issues(
      organization_id, issue_code, severity, source_type, source_id, details
    ) VALUES (
      _org, 'LOAN_RECEIVABLE_DRIFT', 'high', 'employee_loans', NULL,
      jsonb_build_object(
        'gl_balance', v_gl,
        'loans_outstanding_principal', v_loans,
        'drift', v_drift,
        'basis', 'principal',
        'checked_at', now())
    );
  END IF;

  RETURN QUERY SELECT v_loans, v_gl, v_drift;
END $function$;

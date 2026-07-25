CREATE OR REPLACE FUNCTION public.employee_loan_disburse(_loan_id uuid, _bank_account_id uuid, _value_date date DEFAULT NULL::date)
 RETURNS jsonb
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

  INSERT INTO public.journal_entries(
    organization_id, business_id, branch_id, entry_date,
    description, reference, status, posted_at, posted_by,
    source_type, source_id, total_debit, total_credit, created_by
  ) VALUES (
    r.organization_id, r.business_id, NULL, v_entry_date,
    'Loan disbursement — ' || r.loan_number, r.loan_number,
    'posted', now(), auth.uid(),
    'loan_disbursement', r.id, v_amount, v_amount, auth.uid()
  ) RETURNING id INTO v_je_id;

  INSERT INTO public.journal_entry_lines(
    journal_entry_id, account_id, debit, credit, description,
    sort_order, business_id, branch_id
  ) VALUES
    (v_je_id, v_receivable,     v_amount, 0,
     'Loan receivable — '   || r.loan_number, 1, r.business_id, NULL),
    (v_je_id, _bank_account_id, 0, v_amount,
     'Bank disbursement — ' || r.loan_number, 2, r.business_id, NULL);

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
END $function$;
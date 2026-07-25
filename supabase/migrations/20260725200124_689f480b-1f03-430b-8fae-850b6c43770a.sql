
CREATE OR REPLACE FUNCTION public.employee_loan_lifecycle_approve(_loan_id uuid)
 RETURNS employee_loans
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r public.employee_loans; prior text;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  IF r.id IS NULL THEN
    RAISE EXCEPTION 'Loan not found.' USING ERRCODE='22023', HINT='LOAN_CONTEXT_NOT_FOUND';
  END IF;
  prior := r.status;
  IF prior NOT IN ('pending_approval','requested','draft') THEN
    RAISE EXCEPTION 'A loan in status "%" cannot be approved.', prior
      USING ERRCODE='22023', HINT='LOAN_STATE_APPROVE';
  END IF;
  PERFORM public.governance_assert_not_self(
    auth.uid(), COALESCE(r.requested_by, r.created_by), 'loan.approve',
    r.organization_id, 'employee_loan', _loan_id
  );
  PERFORM public.governance_assert_not_subject(
    auth.uid(), r.employee_id, 'loan.approve_self_benefit',
    r.organization_id, 'employee_loan', _loan_id
  );
  UPDATE public.employee_loans SET status='approved', approved_by=auth.uid(), approved_at=now(), updated_at=now()
    WHERE id=_loan_id RETURNING * INTO r;
  PERFORM public._loan_close_approval_request(_loan_id, 'approve', NULL);
  PERFORM public.loan_log_event(_loan_id,'approve',prior,'approved');
  RETURN r;
END $function$;

CREATE OR REPLACE FUNCTION public.employee_loan_authorize_disbursement(_loan_id uuid)
 RETURNS employee_loans
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r public.employee_loans; prior text;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  prior := r.status;
  IF prior <> 'approved' THEN RAISE EXCEPTION 'cannot authorize disbursement in status %', prior; END IF;
  PERFORM public.governance_assert_not_self(
    auth.uid(), COALESCE(r.approved_by, r.requested_by, r.created_by),
    'employee_loan.authorize_disbursement',
    r.organization_id, 'employee_loan', _loan_id
  );
  UPDATE public.employee_loans SET status='awaiting_disbursement', updated_at=now()
    WHERE id=_loan_id RETURNING * INTO r;
  PERFORM public.loan_log_event(_loan_id,'authorize_disbursement',prior,'awaiting_disbursement');
  RETURN r;
END $function$;

CREATE OR REPLACE FUNCTION public.employee_loan_record_manual_repayment(_loan_id uuid, _amount numeric, _repayment_date date, _notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r public.employee_loans; rep_id uuid; next_seq integer;
BEGIN
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'loan not found'; END IF;
  IF r.status NOT IN ('active','in_arrears','paused','restructured') THEN RAISE EXCEPTION 'cannot record repayment in status %', r.status; END IF;
  IF _amount <= 0 THEN RAISE EXCEPTION 'amount must be positive'; END IF;
  PERFORM public.governance_assert_not_self(
    auth.uid(), COALESCE(r.requested_by, r.created_by),
    'employee_loan.record_manual_repayment',
    r.organization_id, 'employee_loan', _loan_id
  );
  SELECT COALESCE(MAX(installment_number),0)+1 INTO next_seq FROM public.loan_repayments WHERE loan_id=_loan_id;
  INSERT INTO public.loan_repayments(loan_id, amount, repayment_date, installment_number, notes, kind, created_by)
    VALUES (_loan_id, _amount, _repayment_date, next_seq, _notes, 'manual', auth.uid())
    RETURNING id INTO rep_id;
  UPDATE public.employee_loans
    SET amount_repaid = amount_repaid + _amount,
        outstanding_balance = GREATEST(0, outstanding_balance - _amount),
        installments_paid = installments_paid + 1, updated_at = now()
    WHERE id = _loan_id;
  PERFORM public.loan_log_event(_loan_id,'record_manual_repayment',r.status,r.status,_amount,_notes,jsonb_build_object('repayment_id',rep_id));
  RETURN rep_id;
END $function$;

CREATE OR REPLACE FUNCTION public.employee_loan_write_off(_loan_id uuid, _reason text, _cosigner uuid)
 RETURNS employee_loans
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r public.employee_loans; prior text; lt public.loan_types;
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
  UPDATE public.employee_loans
    SET status='written_off', writeoff_at=now(), writeoff_by=auth.uid(),
        writeoff_cosigner_id=_cosigner, writeoff_reason=_reason, updated_at=now()
    WHERE id=_loan_id RETURNING * INTO r;
  PERFORM public.loan_log_event(_loan_id,'write_off',prior,'written_off',r.outstanding_balance,_reason,jsonb_build_object('cosigner',_cosigner),_cosigner);
  RETURN r;
END $function$;

CREATE OR REPLACE FUNCTION public.employee_loan_restructure(_loan_id uuid, _kind text, _new_principal numeric, _new_installments integer, _new_start_date date, _new_monthly numeric DEFAULT NULL::numeric, _reason text DEFAULT NULL::text)
 RETURNS employee_loans
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r public.employee_loans; nl public.employee_loans; prior text; new_no text;
BEGIN
  IF _kind NOT IN ('restructure','refinance','topup','consolidation') THEN RAISE EXCEPTION 'invalid kind %', _kind; END IF;
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'loan not found'; END IF;
  prior := r.status;
  IF prior NOT IN ('active','in_arrears','paused') THEN RAISE EXCEPTION 'cannot restructure in status %', prior; END IF;
  PERFORM public.governance_assert_not_self(
    auth.uid(), COALESCE(r.requested_by, r.created_by),
    'employee_loan.restructure',
    r.organization_id, 'employee_loan', _loan_id
  );
  SELECT public.get_next_loan_number(r.organization_id) INTO new_no;
  INSERT INTO public.employee_loans(
    organization_id, business_id, employee_id, loan_number, loan_type, loan_type_id,
    description, principal_amount, interest_rate, total_amount, amount_repaid,
    outstanding_balance, monthly_deduction, total_installments, installments_paid,
    start_date, status, repayment_method, parent_loan_id, refinance_kind, notes, created_by
  ) VALUES (
    r.organization_id, r.business_id, r.employee_id, new_no, r.loan_type, r.loan_type_id,
    COALESCE(_reason, r.description), _new_principal, r.interest_rate, _new_principal, 0,
    _new_principal, COALESCE(_new_monthly, _new_principal/GREATEST(_new_installments,1)),
    _new_installments, 0, _new_start_date, 'approved', r.repayment_method, r.id, _kind,
    COALESCE(_reason,'restructured from '||r.loan_number), auth.uid()
  ) RETURNING * INTO nl;
  UPDATE public.employee_loans SET status='restructured', updated_at=now() WHERE id=_loan_id;
  PERFORM public.loan_log_event(_loan_id,'restructure',prior,'restructured',_new_principal,_reason,jsonb_build_object('new_loan_id',nl.id,'kind',_kind));
  PERFORM public.loan_log_event(nl.id,'submit',NULL,'approved',NULL,'spawned from '||r.loan_number,jsonb_build_object('parent_loan_id',r.id));
  RETURN nl;
END $function$;

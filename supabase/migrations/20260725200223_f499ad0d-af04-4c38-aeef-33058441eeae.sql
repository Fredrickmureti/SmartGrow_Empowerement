
CREATE OR REPLACE FUNCTION public.employee_loan_lifecycle_reject(_loan_id uuid, _reason text)
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
    RAISE EXCEPTION 'A loan in status "%" cannot be rejected.', prior
      USING ERRCODE='22023', HINT='LOAN_STATE_REJECT';
  END IF;
  PERFORM public.governance_assert_not_self(
    auth.uid(), COALESCE(r.requested_by, r.created_by), 'loan.approve',
    r.organization_id, 'employee_loan', _loan_id
  );
  UPDATE public.employee_loans
     SET status='rejected', rejected_by=auth.uid(), rejected_at=now(),
         rejection_reason=_reason, updated_at=now()
   WHERE id=_loan_id RETURNING * INTO r;
  PERFORM public._loan_close_approval_request(_loan_id, 'reject', _reason);
  PERFORM public.loan_log_event(_loan_id,'reject',prior,'rejected',NULL,_reason);
  RETURN r;
END $function$;

CREATE OR REPLACE FUNCTION public.employee_loan_suspend(_loan_id uuid, _reason text DEFAULT NULL::text)
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
  IF prior NOT IN ('active','in_arrears','paused','approved','awaiting_disbursement') THEN
    RAISE EXCEPTION 'A loan in status "%" cannot be suspended.', prior
      USING ERRCODE='22023', HINT='LOAN_STATE_SUSPEND';
  END IF;
  PERFORM public.governance_assert_not_self(
    auth.uid(), COALESCE(r.requested_by, r.created_by), 'employee_loan.restructure',
    r.organization_id, 'employee_loan', _loan_id
  );
  UPDATE public.employee_loans
     SET status='suspended', updated_at=now()
   WHERE id=_loan_id RETURNING * INTO r;
  PERFORM public.loan_log_event(_loan_id,'suspend',prior,'suspended',NULL,_reason);
  RETURN r;
END $function$;

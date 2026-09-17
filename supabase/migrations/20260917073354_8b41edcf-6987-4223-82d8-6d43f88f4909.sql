CREATE OR REPLACE FUNCTION public.mf_cancel_pending_loan(p_loan_id uuid, p_reason text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  l public.mf_loans%ROWTYPE;
  a public.mf_loan_applications%ROWTYPE;
  v_org uuid;
BEGIN
  IF COALESCE(BTRIM(p_reason), '') = '' THEN
    RAISE EXCEPTION 'A reason is required to cancel a loan';
  END IF;

  SELECT * INTO l FROM public.mf_loans WHERE id = p_loan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found'; END IF;

  IF NOT user_has_business_access(auth.uid(), l.business_id) THEN
    RAISE EXCEPTION 'Not authorised for this institution';
  END IF;
  IF NOT (has_role(auth.uid(),'admin')
       OR has_role(auth.uid(),'branch_manager')
       OR has_role(auth.uid(),'credit_officer')) THEN
    RAISE EXCEPTION 'You are not authorised to cancel loans';
  END IF;

  IF l.status <> 'pending_disbursement' THEN
    RAISE EXCEPTION 'Only a loan awaiting disbursement can be cancelled (loan is %)', l.status;
  END IF;

  IF EXISTS (SELECT 1 FROM public.mf_loan_disbursements
              WHERE loan_id = l.id AND reversed_at IS NULL) THEN
    RAISE EXCEPTION 'This loan has a live disbursement — reverse it before cancelling';
  END IF;

  IF EXISTS (SELECT 1 FROM public.mf_repayments WHERE loan_id = l.id) THEN
    RAISE EXCEPTION 'This loan has repayments recorded and cannot be cancelled';
  END IF;

  IF EXISTS (SELECT 1 FROM public.mf_loans WHERE parent_loan_id = l.id) THEN
    RAISE EXCEPTION 'This loan has a successor loan and cannot be cancelled';
  END IF;

  UPDATE public.mf_loans
     SET status = 'cancelled', updated_at = now()
   WHERE id = l.id;

  IF l.application_id IS NOT NULL THEN
    SELECT * INTO a FROM public.mf_loan_applications WHERE id = l.application_id FOR UPDATE;
    IF FOUND AND a.status NOT IN ('cancelled','rejected') THEN
      UPDATE public.mf_loan_applications
         SET status = 'cancelled',
             cancelled_at = now(),
             cancelled_by = auth.uid(),
             cancellation_reason = BTRIM(p_reason),
             updated_at = now()
       WHERE id = a.id;
    END IF;
  END IF;

  INSERT INTO public.mf_loan_events (business_id, loan_id, event_type, actor_id, amount, payload)
  VALUES (l.business_id, l.id, 'loan_cancelled', auth.uid(), l.principal,
          jsonb_build_object('reason', BTRIM(p_reason),
                             'application_id', l.application_id));

  SELECT organization_id INTO v_org FROM public.businesses WHERE id = l.business_id;
  INSERT INTO public.audit_logs (organization_id, business_id, user_id, action, entity_type,
                                 entity_id, entity_name, old_values, new_values, changes_summary)
  VALUES (v_org, l.business_id, auth.uid(), 'cancel', 'mf_loan', l.id, l.loan_number,
          jsonb_build_object('status', l.status),
          jsonb_build_object('status', 'cancelled', 'reason', BTRIM(p_reason)),
          'Undisbursed loan cancelled');

  RETURN l.id;
END;
$$;

REVOKE ALL ON FUNCTION public.mf_cancel_pending_loan(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mf_cancel_pending_loan(uuid, text) TO authenticated, service_role;
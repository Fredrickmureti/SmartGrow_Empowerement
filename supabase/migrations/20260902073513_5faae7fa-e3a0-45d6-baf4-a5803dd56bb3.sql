CREATE OR REPLACE FUNCTION public.mf_disburse_loan(p_loan_id uuid, p_disbursed_on date, p_amount numeric, p_method text, p_reference text DEFAULT NULL::text, p_source_account_id uuid DEFAULT NULL::uuid, p_received_by_name text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  l public.mf_loans%ROWTYPE;
  p public.mf_loans%ROWTYPE;
  v_id uuid; v_shift integer; v_ev uuid; v_settle_ev uuid;
  v_carried numeric;
BEGIN
  SELECT * INTO l FROM public.mf_loans WHERE id = p_loan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found'; END IF;
  IF NOT user_has_business_access(auth.uid(), l.business_id) THEN
    RAISE EXCEPTION 'Not authorised for this institution';
  END IF;
  IF NOT (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin')
       OR has_role(auth.uid(),'branch_manager') OR has_role(auth.uid(),'cashier')) THEN
    RAISE EXCEPTION 'You are not authorised to disburse loans';
  END IF;
  IF l.status <> 'pending_disbursement' THEN
    RAISE EXCEPTION 'This loan is not awaiting disbursement';
  END IF;
  IF EXISTS (SELECT 1 FROM public.mf_loan_disbursements
              WHERE loan_id = p_loan_id AND reversed_at IS NULL) THEN
    RAISE EXCEPTION 'This loan has already been disbursed';
  END IF;
  IF ROUND(p_amount,2) <> ROUND(l.principal,2) THEN
    RAISE EXCEPTION 'Disbursed amount must equal the approved principal';
  END IF;
  IF public.mf_method_mapping_key(p_method) IS NULL THEN
    RAISE EXCEPTION 'Unknown disbursement method %', p_method;
  END IF;

  INSERT INTO public.mf_loan_disbursements (
    business_id, loan_id, disbursed_on, amount, method, reference,
    source_account_id, received_by_name, notes, disbursed_by)
  VALUES (l.business_id, l.id, p_disbursed_on, p_amount, p_method, p_reference,
          p_source_account_id, p_received_by_name, p_notes, auth.uid())
  RETURNING id INTO v_id;

  IF l.expected_disbursement_date IS DISTINCT FROM p_disbursed_on THEN
    v_shift := p_disbursed_on - l.expected_disbursement_date;
    UPDATE public.mf_loan_schedule SET due_date = due_date + v_shift, updated_at = now()
     WHERE loan_id = l.id;
  END IF;

  UPDATE public.mf_loans
     SET status = 'active', disbursed_at = now(),
         first_installment_date = (SELECT MIN(due_date) FROM public.mf_loan_schedule WHERE loan_id = l.id),
         updated_at = now()
   WHERE id = l.id;

  INSERT INTO public.mf_loan_events (business_id, loan_id, event_type, actor_id, amount, payload)
  VALUES (l.business_id, l.id, 'loan_disbursed', auth.uid(), p_amount,
          jsonb_build_object('method', p_method, 'reference', p_reference,
                             'disbursed_on', p_disbursed_on, 'disbursement_id', v_id))
  RETURNING id INTO v_ev;

  -- accounting hook: DR principal receivable / CR cash-bank-mobile money
  PERFORM public.mf_post_event(v_ev);

  -- top-up / restructure: settle the loan this one replaces out of the proceeds
  IF l.parent_loan_id IS NOT NULL THEN
    SELECT * INTO p FROM public.mf_loans WHERE id = l.parent_loan_id FOR UPDATE;
    IF p.status <> 'active' THEN
      RAISE EXCEPTION 'The loan being replaced is no longer active';
    END IF;

    SELECT ROUND(COALESCE(principal_outstanding,0),2) INTO v_carried
      FROM public.mf_loan_balances WHERE loan_id = p.id;
    IF COALESCE(v_carried,0) <= 0 THEN
      RAISE EXCEPTION 'Loan % has no outstanding principal to settle', p.loan_number;
    END IF;

    INSERT INTO public.mf_loan_events (business_id, loan_id, event_type, actor_id, amount, payload)
    VALUES (p.business_id, p.id, 'loan_settled_by_successor', auth.uid(), v_carried,
            jsonb_build_object('successor_loan_id', l.id,
                               'successor_loan_number', l.loan_number,
                               'lineage_kind', l.lineage_kind,
                               'carried_principal', v_carried,
                               'method', p_method,
                               'settled_on', p_disbursed_on))
    RETURNING id INTO v_settle_ev;

    PERFORM public.mf_post_event(v_settle_ev);

    UPDATE public.mf_loans
       SET status = 'closed', closed_at = now(), updated_at = now()
     WHERE id = p.id;
  END IF;

  IF l.application_id IS NOT NULL THEN
    UPDATE public.mf_loan_applications SET status = 'disbursed', updated_at = now()
     WHERE id = l.application_id;
  END IF;

  RETURN v_id;
END; $function$;
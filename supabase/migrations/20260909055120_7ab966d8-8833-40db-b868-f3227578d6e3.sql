CREATE OR REPLACE FUNCTION public.mf_create_loan_from_application(p_application_id uuid, p_expected_disbursement_date date DEFAULT NULL::date, p_first_installment_date date DEFAULT NULL::date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  a public.mf_loan_applications%ROWTYPE;
  v public.mf_loan_product_versions%ROWTYPE;
  v_loan_id uuid; v_number text; v_seq integer; v_first date;
  v_amount numeric; v_term integer;
BEGIN
  SELECT * INTO a FROM public.mf_loan_applications WHERE id = p_application_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Application not found'; END IF;
  IF NOT user_has_business_access(auth.uid(), a.business_id) THEN
    RAISE EXCEPTION 'Not authorised for this institution';
  END IF;
  IF NOT (has_role(auth.uid(),'admin')
       OR has_role(auth.uid(),'branch_manager') OR has_role(auth.uid(),'credit_officer')) THEN
    RAISE EXCEPTION 'You are not authorised to create loans';
  END IF;
  IF a.status NOT IN ('approved','ready_for_disbursement') THEN
    RAISE EXCEPTION 'Only an approved application can become a loan';
  END IF;
  IF EXISTS (SELECT 1 FROM public.mf_loans WHERE application_id = a.id) THEN
    RAISE EXCEPTION 'This application already has a loan';
  END IF;

  SELECT * INTO v FROM public.mf_loan_product_versions WHERE id = a.product_version_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product version missing on the application'; END IF;

  v_amount := COALESCE(a.approved_amount, a.requested_amount);
  v_term   := COALESCE(a.approved_term_installments, a.requested_term_installments);

  -- The product version is the contractual envelope: a loan may never be
  -- written outside the amount or term band it was approved against.
  IF v_amount < v.min_amount OR v_amount > v.max_amount THEN
    RAISE EXCEPTION 'The loan amount % is outside the product band % to %',
      v_amount, v.min_amount, v.max_amount;
  END IF;
  IF v_term < v.min_term_installments OR v_term > v.max_term_installments THEN
    RAISE EXCEPTION 'The installment count % is outside the product band % to %',
      v_term, v.min_term_installments, v.max_term_installments;
  END IF;

  SELECT COALESCE(MAX(NULLIF(regexp_replace(loan_number,'\D','','g'),'')::integer),0) + 1
    INTO v_seq FROM public.mf_loans WHERE business_id = a.business_id;
  v_number := 'LN-' || to_char(v_seq, 'FM000000');

  v_first := COALESCE(p_first_installment_date,
    public.mf_add_period(COALESCE(p_expected_disbursement_date, CURRENT_DATE),
                         v.repayment_frequency, 1));

  INSERT INTO public.mf_loans (
    business_id, branch_id, loan_number, application_id, client_id, group_id,
    product_id, product_version_id, loan_officer_id, currency_code, principal,
    term_installments, repayment_frequency, interest_method, interest_rate,
    interest_rate_period, grace_period_installments, fees, penalty_rate,
    penalty_basis, expected_disbursement_date, first_installment_date, created_by)
  VALUES (
    a.business_id, a.branch_id, v_number, a.id, a.client_id, a.group_id,
    a.product_id, a.product_version_id, a.loan_officer_id, v.currency_code,
    v_amount, v_term,
    v.repayment_frequency, v.interest_method, COALESCE(v.interest_rate,0),
    COALESCE(v.interest_rate_period,'per_annum'), COALESCE(v.grace_period_installments,0),
    COALESCE(v.fees,'[]'::jsonb), COALESCE(v.penalty_rate,0), v.penalty_basis,
    COALESCE(p_expected_disbursement_date, CURRENT_DATE), v_first, auth.uid())
  RETURNING id INTO v_loan_id;

  PERFORM public.mf_generate_schedule(v_loan_id);

  INSERT INTO public.mf_loan_events (business_id, loan_id, event_type, actor_id, amount, payload)
  VALUES (a.business_id, v_loan_id, 'loan_created', auth.uid(), v_amount,
          jsonb_build_object('application_id', a.id, 'loan_number', v_number));

  UPDATE public.mf_loan_applications SET status = 'ready_for_disbursement', updated_at = now()
   WHERE id = a.id AND status = 'approved';

  RETURN v_loan_id;
END; $function$;
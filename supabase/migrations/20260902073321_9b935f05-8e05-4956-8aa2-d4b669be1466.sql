CREATE OR REPLACE FUNCTION public.mf_reissue_loan(
  p_loan_id uuid,
  p_kind text,
  p_additional_principal numeric DEFAULT 0,
  p_term_installments integer DEFAULT NULL,
  p_interest_rate numeric DEFAULT NULL,
  p_expected_disbursement_date date DEFAULT NULL,
  p_first_installment_date date DEFAULT NULL,
  p_reason text DEFAULT NULL
) RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  l public.mf_loans%ROWTYPE;
  v_outstanding_principal numeric;
  v_new_id uuid; v_number text; v_seq integer;
  v_term integer; v_first date; v_expected date;
BEGIN
  IF p_kind NOT IN ('topup','restructure') THEN
    RAISE EXCEPTION 'Unknown reissue kind %', p_kind;
  END IF;
  IF COALESCE(btrim(p_reason),'') = '' THEN
    RAISE EXCEPTION 'A reason is required to % a loan', p_kind;
  END IF;

  SELECT * INTO l FROM public.mf_loans WHERE id = p_loan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found'; END IF;
  IF NOT user_has_business_access(auth.uid(), l.business_id) THEN
    RAISE EXCEPTION 'Not authorised for this institution';
  END IF;
  IF NOT (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin')
       OR has_role(auth.uid(),'branch_manager') OR has_role(auth.uid(),'credit_officer')) THEN
    RAISE EXCEPTION 'You are not authorised to restructure or top up loans';
  END IF;
  IF l.status <> 'active' THEN
    RAISE EXCEPTION 'Only an active loan can be topped up or restructured (loan is %)', l.status;
  END IF;
  IF EXISTS (SELECT 1 FROM public.mf_loans WHERE parent_loan_id = l.id) THEN
    RAISE EXCEPTION 'This loan has already been replaced';
  END IF;

  SELECT ROUND(COALESCE(principal_outstanding,0),2) INTO v_outstanding_principal
    FROM public.mf_loan_balances WHERE loan_id = l.id;
  IF COALESCE(v_outstanding_principal,0) <= 0 THEN
    RAISE EXCEPTION 'Loan % has no outstanding principal to carry forward', l.loan_number;
  END IF;

  IF p_kind = 'topup' AND COALESCE(p_additional_principal,0) <= 0 THEN
    RAISE EXCEPTION 'A top-up requires an additional amount';
  END IF;
  IF p_kind = 'restructure' AND COALESCE(p_additional_principal,0) <> 0 THEN
    RAISE EXCEPTION 'A restructure cannot add new principal; use a top-up';
  END IF;

  v_term := COALESCE(p_term_installments, l.term_installments);
  IF v_term <= 0 THEN RAISE EXCEPTION 'Term must be at least one installment'; END IF;

  v_expected := COALESCE(p_expected_disbursement_date, CURRENT_DATE);
  v_first := COALESCE(p_first_installment_date,
                      public.mf_add_period(v_expected, l.repayment_frequency, 1));

  SELECT COALESCE(MAX(NULLIF(regexp_replace(loan_number,'\D','','g'),'')::integer),0) + 1
    INTO v_seq FROM public.mf_loans WHERE business_id = l.business_id;
  v_number := 'LN-' || to_char(v_seq, 'FM000000');

  INSERT INTO public.mf_loans (
    business_id, branch_id, loan_number, application_id, client_id, group_id,
    product_id, product_version_id, loan_officer_id, currency_code, principal,
    term_installments, repayment_frequency, interest_method, interest_rate,
    interest_rate_period, grace_period_installments, fees, penalty_rate,
    penalty_basis, expected_disbursement_date, first_installment_date, created_by,
    parent_loan_id, lineage_kind, status)
  VALUES (
    l.business_id, l.branch_id, v_number, NULL, l.client_id, l.group_id,
    l.product_id, l.product_version_id, l.loan_officer_id, l.currency_code,
    v_outstanding_principal + COALESCE(p_additional_principal,0),
    v_term, l.repayment_frequency, l.interest_method,
    COALESCE(p_interest_rate, l.interest_rate), l.interest_rate_period,
    0, '[]'::jsonb, l.penalty_rate, l.penalty_basis,
    v_expected, v_first, auth.uid(),
    l.id, p_kind, 'pending_disbursement')
  RETURNING id INTO v_new_id;

  PERFORM public.mf_generate_schedule(v_new_id);

  UPDATE public.mf_loans
     SET settled_by_loan_id = v_new_id, updated_at = now()
   WHERE id = l.id;

  INSERT INTO public.mf_loan_events (business_id, loan_id, event_type, actor_id, amount, payload)
  VALUES (l.business_id, l.id,
          CASE p_kind WHEN 'topup' THEN 'loan_topped_up' ELSE 'loan_restructured' END,
          auth.uid(), v_outstanding_principal + COALESCE(p_additional_principal,0),
          jsonb_build_object('successor_loan_id', v_new_id,
                             'successor_loan_number', v_number,
                             'carried_principal', v_outstanding_principal,
                             'additional_principal', COALESCE(p_additional_principal,0),
                             'reason', p_reason));

  RETURN v_new_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.mf_reissue_loan(uuid, text, numeric, integer, numeric, date, date, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.mf_reissue_loan(uuid, text, numeric, integer, numeric, date, date, text) TO authenticated;
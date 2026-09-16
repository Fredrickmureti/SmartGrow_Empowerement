-- 1. Product version + loan snapshot: how interest is collected -------------
ALTER TABLE public.mf_loan_product_versions
  ADD COLUMN IF NOT EXISTS interest_collection text NOT NULL DEFAULT 'with_installments';
ALTER TABLE public.mf_loan_product_versions
  DROP CONSTRAINT IF EXISTS mf_loan_product_versions_interest_collection_chk;
ALTER TABLE public.mf_loan_product_versions
  ADD CONSTRAINT mf_loan_product_versions_interest_collection_chk
  CHECK (interest_collection IN ('with_installments','deducted_upfront')
         AND (interest_collection = 'with_installments' OR interest_method = 'flat'));

ALTER TABLE public.mf_loans
  ADD COLUMN IF NOT EXISTS interest_collection text NOT NULL DEFAULT 'with_installments';
ALTER TABLE public.mf_loans
  DROP CONSTRAINT IF EXISTS mf_loans_interest_collection_chk;
ALTER TABLE public.mf_loans
  ADD CONSTRAINT mf_loans_interest_collection_chk
  CHECK (interest_collection IN ('with_installments','deducted_upfront')
         AND (interest_collection = 'with_installments' OR interest_method = 'flat'));

-- 2. Disbursement record: keep the components apart -------------------------
ALTER TABLE public.mf_loan_disbursements
  ADD COLUMN IF NOT EXISTS upfront_interest numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fees_paid_by_client numeric(18,2) NOT NULL DEFAULT 0;

-- 3. Freeze the new term with the rest of the contract ----------------------
CREATE OR REPLACE FUNCTION public.mf_loans_freeze_terms()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  IF OLD.principal IS DISTINCT FROM NEW.principal
     OR OLD.term_installments IS DISTINCT FROM NEW.term_installments
     OR OLD.interest_rate IS DISTINCT FROM NEW.interest_rate
     OR OLD.interest_method IS DISTINCT FROM NEW.interest_method
     OR OLD.interest_collection IS DISTINCT FROM NEW.interest_collection
     OR OLD.repayment_frequency IS DISTINCT FROM NEW.repayment_frequency
     OR OLD.product_version_id IS DISTINCT FROM NEW.product_version_id THEN
    IF OLD.status <> 'pending_disbursement' THEN
      RAISE EXCEPTION 'Contractual terms cannot be changed once the loan is disbursed';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END; $function$;

-- 4. Fees: recognise the third collection mode explicitly -------------------
CREATE OR REPLACE FUNCTION public.mf_compute_loan_fees(p_loan_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  l public.mf_loans%ROWTYPE;
  v_fee jsonb;
  v_basis text;
  v_collection text;
  v_amount numeric(18,2);
  v_out jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO l FROM public.mf_loans WHERE id = p_loan_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found'; END IF;

  FOR v_fee IN SELECT * FROM jsonb_array_elements(COALESCE(l.fees, '[]'::jsonb)) LOOP
    v_basis := COALESCE(v_fee->>'basis',
                 CASE WHEN COALESCE(v_fee->>'type','fixed') = 'percent'
                      THEN 'percent_of_principal' ELSE 'fixed' END);
    v_collection := COALESCE(v_fee->>'collection',
                 CASE WHEN COALESCE(v_fee->>'timing','upfront') IN ('upfront','on_disbursement','deducted_from_disbursement')
                      THEN 'deducted_from_disbursement' ELSE 'added_to_first_installment' END);
    IF v_collection NOT IN ('deducted_from_disbursement','added_to_first_installment','paid_at_disbursement') THEN
      RAISE EXCEPTION 'Unknown fee collection mode "%" on loan %', v_collection, l.loan_number;
    END IF;
    v_amount := CASE WHEN v_basis = 'percent_of_principal'
                     THEN ROUND(l.principal * COALESCE((v_fee->>'value')::numeric, 0) / 100.0, 2)
                     ELSE ROUND(COALESCE((v_fee->>'value')::numeric, 0), 2) END;
    IF v_amount <= 0 THEN CONTINUE; END IF;
    v_out := v_out || jsonb_build_object(
      'name', COALESCE(NULLIF(btrim(COALESCE(v_fee->>'name','')), ''), 'Processing fee'),
      'basis', v_basis,
      'value', COALESCE((v_fee->>'value')::numeric, 0),
      'collection', v_collection,
      'amount', v_amount);
  END LOOP;

  RETURN v_out;
END; $function$;

-- 5. Full-term interest when the product collects it upfront ----------------
CREATE OR REPLACE FUNCTION public.mf_loan_upfront_interest(p_loan_id uuid)
RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  l public.mf_loans%ROWTYPE;
  v_basis text; v_rate numeric; v_ppy numeric; v_period_rate numeric;
BEGIN
  SELECT * INTO l FROM public.mf_loans WHERE id = p_loan_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found'; END IF;
  IF COALESCE(l.interest_collection,'with_installments') <> 'deducted_upfront' THEN
    RETURN 0;
  END IF;
  IF l.interest_method <> 'flat' THEN
    RAISE EXCEPTION 'Interest can only be deducted upfront on a flat-interest loan (loan %)', l.loan_number;
  END IF;

  v_basis := COALESCE(NULLIF(l.interest_rate_period, ''), 'per_annum');
  IF v_basis = 'per_year'  THEN v_basis := 'per_annum'; END IF;
  IF v_basis = 'per_period' THEN v_basis := 'per_installment'; END IF;
  v_rate := COALESCE(l.interest_rate, 0) / 100.0;

  IF v_basis = 'flat_on_principal' THEN
    RETURN ROUND(l.principal * v_rate, 2);
  END IF;

  v_ppy := public.mf_periods_per_year(l.repayment_frequency);
  v_period_rate := CASE v_basis
    WHEN 'per_installment' THEN v_rate
    WHEN 'per_month'       THEN v_rate * 12 / v_ppy
    WHEN 'per_annum'       THEN v_rate / v_ppy
    ELSE NULL END;
  IF v_period_rate IS NULL THEN
    RAISE EXCEPTION 'Unknown interest rate basis "%" on loan %', v_basis, l.loan_number;
  END IF;

  RETURN ROUND(l.principal * v_period_rate * l.term_installments, 2);
END; $function$;

GRANT EXECUTE ON FUNCTION public.mf_loan_upfront_interest(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mf_loan_upfront_interest(uuid) TO service_role;

-- 6. Schedule: upfront interest leaves a principal-only schedule ------------
CREATE OR REPLACE FUNCTION public.mf_generate_schedule(p_loan_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  l public.mf_loans%ROWTYPE;
  v_rate numeric; v_ppy numeric; v_period_rate numeric;
  v_basis text; v_method text;
  v_n integer; v_i integer; v_bal numeric; v_prin numeric; v_int numeric;
  v_flat_interest numeric; v_installment numeric; v_due date;
  v_first_fees numeric := 0; v_paying integer;
  v_upfront boolean;
BEGIN
  SELECT * INTO l FROM public.mf_loans WHERE id = p_loan_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found'; END IF;
  IF l.status <> 'pending_disbursement' THEN
    RAISE EXCEPTION 'Schedule can only be generated before disbursement';
  END IF;

  DELETE FROM public.mf_loan_schedule WHERE loan_id = p_loan_id;

  v_method := l.interest_method;
  IF v_method NOT IN ('flat','declining_balance','declining_balance_equal_installments') THEN
    RAISE EXCEPTION 'Unknown interest method "%" on loan %', v_method, l.loan_number;
  END IF;

  -- Legacy spellings are normalised, anything unknown is refused outright.
  v_basis := COALESCE(NULLIF(l.interest_rate_period, ''), 'per_annum');
  IF v_basis = 'per_year' THEN v_basis := 'per_annum'; END IF;
  IF v_basis = 'per_period' THEN v_basis := 'per_installment'; END IF;
  IF v_basis NOT IN ('per_annum','per_month','per_installment','flat_on_principal') THEN
    RAISE EXCEPTION 'Unknown interest rate basis "%" on loan % — the schedule cannot be priced',
      v_basis, l.loan_number;
  END IF;
  IF v_basis = 'flat_on_principal' AND v_method <> 'flat' THEN
    RAISE EXCEPTION 'Rate basis "flat on principal" is only valid with flat interest (loan %)',
      l.loan_number;
  END IF;

  -- Validates the combination and refuses an unsupported one.
  PERFORM public.mf_loan_upfront_interest(p_loan_id);
  v_upfront := COALESCE(l.interest_collection,'with_installments') = 'deducted_upfront';

  v_ppy := public.mf_periods_per_year(l.repayment_frequency);
  v_rate := COALESCE(l.interest_rate, 0) / 100.0;
  v_period_rate := CASE v_basis
    WHEN 'per_installment'   THEN v_rate
    WHEN 'per_month'         THEN v_rate * 12 / v_ppy
    WHEN 'per_annum'         THEN v_rate / v_ppy
    ELSE NULL END;  -- flat_on_principal has no per-period rate

  v_n := l.term_installments;
  v_paying := GREATEST(v_n - COALESCE(l.grace_period_installments,0), 1);
  v_bal := l.principal;

  v_first_fees := public.mf_loan_fee_total(p_loan_id, 'added_to_first_installment');

  IF v_method = 'flat' THEN
    -- Interest taken at payout is never charged again on the schedule.
    v_flat_interest := CASE
      WHEN v_upfront THEN 0
      WHEN v_basis = 'flat_on_principal' THEN ROUND(l.principal * v_rate, 2)
      ELSE ROUND(l.principal * v_period_rate * v_n, 2) END;
  ELSE
    IF v_period_rate > 0 THEN
      v_installment := ROUND(l.principal * v_period_rate
        / (1 - POWER(1 + v_period_rate, -v_paying)), 2);
    ELSE
      v_installment := ROUND(l.principal / v_paying, 2);
    END IF;
  END IF;

  FOR v_i IN 1..v_n LOOP
    v_due := public.mf_add_period(
      COALESCE(l.first_installment_date, l.expected_disbursement_date, CURRENT_DATE),
      l.repayment_frequency, v_i - 1);

    IF v_i <= COALESCE(l.grace_period_installments,0) THEN
      v_prin := 0;
      v_int := CASE WHEN v_method = 'flat' THEN 0
                    ELSE ROUND(v_bal * v_period_rate, 2) END;
    ELSIF v_method = 'flat' THEN
      v_prin := ROUND(l.principal / v_paying, 2);
      v_int := ROUND(v_flat_interest / v_paying, 2);
      IF v_i = v_n THEN
        v_prin := v_bal;
        -- last paying installment absorbs the rounding residual on interest
        v_int := v_flat_interest - ROUND(v_flat_interest / v_paying, 2) * (v_paying - 1);
      END IF;
    ELSE
      v_int := ROUND(v_bal * v_period_rate, 2);
      v_prin := LEAST(v_installment - v_int, v_bal);
      IF v_i = v_n THEN v_prin := v_bal; END IF;
      IF v_prin < 0 THEN v_prin := 0; END IF;
    END IF;

    INSERT INTO public.mf_loan_schedule (
      business_id, loan_id, installment_no, due_date, opening_balance,
      principal_due, interest_due, fees_due, total_due, closing_balance, is_grace)
    VALUES (l.business_id, l.id, v_i, v_due, v_bal, v_prin, v_int,
      CASE WHEN v_i = 1 THEN v_first_fees ELSE 0 END,
      v_prin + v_int + CASE WHEN v_i = 1 THEN v_first_fees ELSE 0 END,
      v_bal - v_prin, v_i <= COALESCE(l.grace_period_installments,0));

    v_bal := v_bal - v_prin;
  END LOOP;

  RETURN v_n;
END; $function$;

-- 7. Loan creation carries the setting into the frozen contract -------------
CREATE OR REPLACE FUNCTION public.mf_create_loan_from_application(p_application_id uuid, p_expected_disbursement_date date DEFAULT NULL::date, p_first_installment_date date DEFAULT NULL::date)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
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

  -- A loan is written from what was approved, never from what was requested.
  IF a.approved_amount IS NULL OR a.approved_term_installments IS NULL THEN
    RAISE EXCEPTION 'This application has no approved amount and term — it cannot become a loan';
  END IF;
  v_amount := a.approved_amount;
  v_term   := a.approved_term_installments;

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
    interest_rate_period, interest_collection, grace_period_installments, fees, penalty_rate,
    penalty_basis, expected_disbursement_date, first_installment_date, created_by)
  VALUES (
    a.business_id, a.branch_id, v_number, a.id, a.client_id, a.group_id,
    a.product_id, a.product_version_id, a.loan_officer_id, v.currency_code,
    v_amount, v_term,
    v.repayment_frequency, v.interest_method, COALESCE(v.interest_rate,0),
    COALESCE(v.interest_rate_period,'per_annum'),
    COALESCE(v.interest_collection,'with_installments'),
    COALESCE(v.grace_period_installments,0),
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

-- 8. A reissue inherits the predecessor's interest collection ---------------
CREATE OR REPLACE FUNCTION public.mf_reissue_loan(p_loan_id uuid, p_kind text, p_additional_principal numeric DEFAULT 0, p_term_installments integer DEFAULT NULL::integer, p_interest_rate numeric DEFAULT NULL::numeric, p_expected_disbursement_date date DEFAULT NULL::date, p_first_installment_date date DEFAULT NULL::date, p_reason text DEFAULT NULL::text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
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
  IF NOT (has_role(auth.uid(),'admin')
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
    interest_rate_period, interest_collection, grace_period_installments, fees, penalty_rate,
    penalty_basis, expected_disbursement_date, first_installment_date, created_by,
    parent_loan_id, lineage_kind, status)
  VALUES (
    l.business_id, l.branch_id, v_number, NULL, l.client_id, l.group_id,
    l.product_id, l.product_version_id, l.loan_officer_id, l.currency_code,
    v_outstanding_principal + COALESCE(p_additional_principal,0),
    v_term, l.repayment_frequency, l.interest_method,
    COALESCE(p_interest_rate, l.interest_rate), l.interest_rate_period,
    COALESCE(l.interest_collection,'with_installments'),
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
END; $function$;

-- 9. Disbursement: principal, upfront interest, and the two fee modes -------
CREATE OR REPLACE FUNCTION public.mf_disburse_loan(p_loan_id uuid, p_disbursed_on date, p_amount numeric, p_method text, p_reference text DEFAULT NULL::text, p_source_account_id uuid DEFAULT NULL::uuid, p_received_by_name text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  l public.mf_loans%ROWTYPE;
  p public.mf_loans%ROWTYPE;
  v_id uuid; v_shift integer; v_ev uuid; v_settle_ev uuid;
  v_carried numeric;
  v_fees jsonb; v_deducted numeric(18,2); v_net numeric(18,2);
  v_client_fee numeric(18,2); v_upfront numeric(18,2);
BEGIN
  SELECT * INTO l FROM public.mf_loans WHERE id = p_loan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found'; END IF;
  IF NOT user_has_business_access(auth.uid(), l.business_id) THEN
    RAISE EXCEPTION 'Not authorised for this institution';
  END IF;
  IF NOT (has_role(auth.uid(),'admin')
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

  v_fees       := public.mf_compute_loan_fees(p_loan_id);
  v_deducted   := public.mf_loan_fee_total(p_loan_id, 'deducted_from_disbursement');
  v_client_fee := public.mf_loan_fee_total(p_loan_id, 'paid_at_disbursement');
  v_upfront    := public.mf_loan_upfront_interest(p_loan_id);

  -- A fee the client hands over is money in, never a reduction of the payout.
  v_net := ROUND(p_amount, 2) - v_deducted - v_upfront;
  IF v_net <= 0 THEN
    RAISE EXCEPTION 'Deductions of % would leave nothing to pay out on a principal of %',
      v_deducted + v_upfront, ROUND(p_amount,2);
  END IF;

  INSERT INTO public.mf_loan_disbursements (
    business_id, loan_id, disbursed_on, amount, method, reference,
    source_account_id, received_by_name, notes, disbursed_by,
    fees_deducted, net_amount, fee_breakdown, upfront_interest, fees_paid_by_client)
  VALUES (l.business_id, l.id, p_disbursed_on, p_amount, p_method, p_reference,
          p_source_account_id, p_received_by_name, p_notes, auth.uid(),
          v_deducted, v_net, v_fees, v_upfront, v_client_fee)
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
                             'disbursed_on', p_disbursed_on, 'disbursement_id', v_id,
                             'fees_deducted', v_deducted, 'net_amount', v_net,
                             'upfront_interest', v_upfront,
                             'fees_paid_by_client', v_client_fee,
                             'fee_breakdown', v_fees))
  RETURNING id INTO v_ev;

  PERFORM public.mf_post_event(v_ev);

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

-- 10. Disbursement ledger: interest income and client-paid fee -------------
CREATE OR REPLACE FUNCTION public.mf_post_event(p_event_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  ev        public.mf_loan_events%ROWTYPE;
  l         public.mf_loans%ROWTYPE;
  v_org     uuid;
  v_je      uuid;
  v_lines   jsonb := '[]'::jsonb;
  v_desc    text;
  v_ref     text;
  v_kind    text := 'original';
  v_cash_key text;
  v_orig_je uuid;
  v_orig_ev uuid;
  v_principal numeric;
  v_interest  numeric;
  v_fees      numeric;
  v_client_fee numeric;
  v_upfront   numeric;
  r         record;
BEGIN
  SELECT * INTO ev FROM public.mf_loan_events WHERE id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan event % not found', p_event_id; END IF;

  SELECT journal_entry_id INTO v_je FROM public.mf_event_postings WHERE loan_event_id = p_event_id;
  IF v_je IS NOT NULL THEN RETURN v_je; END IF;

  SELECT * INTO l FROM public.mf_loans WHERE id = ev.loan_id;
  SELECT organization_id INTO v_org FROM public.businesses WHERE id = ev.business_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Institution % has no organization', ev.business_id; END IF;

  IF ev.event_type = 'loan_disbursed' THEN
    v_cash_key   := public.mf_method_mapping_key(ev.payload->>'method');
    v_fees       := ROUND(COALESCE((ev.payload->>'fees_deducted')::numeric, 0), 2);
    v_upfront    := ROUND(COALESCE((ev.payload->>'upfront_interest')::numeric, 0), 2);
    v_client_fee := ROUND(COALESCE((ev.payload->>'fees_paid_by_client')::numeric, 0), 2);
    v_desc := format('Loan disbursement %s', l.loan_number);
    v_ref  := COALESCE(ev.payload->>'reference', l.loan_number);
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', public.mf_resolve_account(ev.business_id, l.branch_id, 'principal_receivable'),
                         'debit', ev.amount, 'credit', 0, 'description', v_desc));
    IF v_fees > 0 THEN
      v_lines := v_lines || jsonb_build_object(
        'account_id', public.mf_resolve_account(ev.business_id, l.branch_id, 'fee_income'),
        'debit', 0, 'credit', v_fees, 'description', v_desc || ' - fees deducted');
    END IF;
    -- Interest collected at payout is earned there; nothing remains receivable.
    IF v_upfront > 0 THEN
      v_lines := v_lines || jsonb_build_object(
        'account_id', public.mf_resolve_account(ev.business_id, l.branch_id, 'interest_income'),
        'debit', 0, 'credit', v_upfront, 'description', v_desc || ' - interest deducted upfront');
    END IF;
    -- A fee the client hands over is cash in and income, not a netting.
    IF v_client_fee > 0 THEN
      v_lines := v_lines || jsonb_build_object(
        'account_id', public.mf_resolve_account(ev.business_id, l.branch_id, v_cash_key),
        'debit', v_client_fee, 'credit', 0, 'description', v_desc || ' - fee received from client');
      v_lines := v_lines || jsonb_build_object(
        'account_id', public.mf_resolve_account(ev.business_id, l.branch_id, 'fee_income'),
        'debit', 0, 'credit', v_client_fee, 'description', v_desc || ' - fee paid by client');
    END IF;
    v_lines := v_lines || jsonb_build_object(
      'account_id', public.mf_resolve_account(ev.business_id, l.branch_id, v_cash_key),
      'debit', 0, 'credit', ROUND(ev.amount, 2) - v_fees - v_upfront,
      'description', v_desc || CASE WHEN v_fees + v_upfront > 0 THEN ' - net paid out' ELSE '' END);

  ELSIF ev.event_type = 'loan_settled_by_successor' THEN
    v_cash_key := public.mf_method_mapping_key(ev.payload->>'method');
    v_principal := COALESCE((ev.payload->>'carried_principal')::numeric, 0);
    IF v_principal <= 0 THEN
      RAISE EXCEPTION 'Loan % has no outstanding principal to settle', l.loan_number;
    END IF;
    v_desc := format('Settlement of loan %s by %s %s', l.loan_number,
                     COALESCE(ev.payload->>'lineage_kind','reissue'),
                     COALESCE(ev.payload->>'successor_loan_number',''));
    v_ref  := l.loan_number;
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', public.mf_resolve_account(ev.business_id, l.branch_id, v_cash_key),
                         'debit', v_principal, 'credit', 0, 'description', v_desc),
      jsonb_build_object('account_id', public.mf_resolve_account(ev.business_id, l.branch_id, 'principal_receivable'),
                         'debit', 0, 'credit', v_principal, 'description', v_desc));

  ELSIF ev.event_type = 'repayment_recorded' THEN
    v_cash_key := public.mf_method_mapping_key(ev.payload->>'method');
    v_desc := format('Loan repayment %s receipt %s', l.loan_number, COALESCE(ev.payload->>'receipt_number',''));
    v_ref  := COALESCE(ev.payload->>'receipt_number', l.loan_number);
    IF COALESCE(ev.amount, 0) > 0 THEN
      v_lines := v_lines || jsonb_build_object(
        'account_id', public.mf_resolve_account(ev.business_id, l.branch_id, v_cash_key),
        'debit', ev.amount, 'credit', 0, 'description', v_desc);
    END IF;
    FOR r IN
      SELECT component, SUM(amount) AS amount
      FROM public.mf_repayment_allocations
      WHERE repayment_id = (ev.payload->>'repayment_id')::uuid
      GROUP BY component
    LOOP
      IF r.amount = 0 THEN CONTINUE; END IF;
      v_lines := v_lines || jsonb_build_object(
        'account_id', public.mf_resolve_account(ev.business_id, l.branch_id,
          CASE r.component
            WHEN 'principal' THEN 'principal_receivable'
            WHEN 'interest'  THEN 'interest_income'
            WHEN 'fee'       THEN 'fee_income'
            WHEN 'penalty'   THEN 'penalty_income'
            WHEN 'advance'   THEN 'client_advance'
            ELSE NULL END),
        'debit',  CASE WHEN r.amount < 0 THEN -r.amount ELSE 0 END,
        'credit', CASE WHEN r.amount > 0 THEN  r.amount ELSE 0 END,
        'description', v_desc || ' - ' || r.component);
    END LOOP;
    IF jsonb_array_length(v_lines) < 2 THEN
      RAISE EXCEPTION 'Repayment % has no allocations to post', ev.payload->>'repayment_id';
    END IF;

  ELSIF ev.event_type = 'repayment_reversed' THEN
    v_kind := 'reversal';
    SELECT e.id INTO v_orig_ev FROM public.mf_loan_events e
     WHERE e.loan_id = ev.loan_id AND e.event_type = 'repayment_recorded'
       AND e.payload->>'repayment_id' = ev.payload->>'repayment_id'
     ORDER BY e.event_at DESC LIMIT 1;
    IF v_orig_ev IS NULL THEN
      RAISE EXCEPTION 'No original posting found for repayment %', ev.payload->>'repayment_id';
    END IF;
    SELECT journal_entry_id INTO v_orig_je FROM public.mf_event_postings WHERE loan_event_id = v_orig_ev;
    IF v_orig_je IS NULL THEN
      RAISE EXCEPTION 'Original repayment was never posted; nothing to reverse';
    END IF;
    v_je := public.void_journal_entry_atomic(v_orig_je,
      format('Reversal of repayment %s', COALESCE(ev.payload->>'receipt_number','')), COALESCE(ev.actor_id, auth.uid()), NULL, COALESCE((ev.payload->>'effective_on')::date, ev.event_at::date, CURRENT_DATE));
    INSERT INTO public.mf_event_postings (business_id, loan_event_id, journal_entry_id, posting_kind)
    VALUES (ev.business_id, ev.id, v_je, 'reversal');
    RETURN v_je;

  ELSIF ev.event_type = 'disbursement_reversed' THEN
    v_kind := 'reversal';
    SELECT e.id INTO v_orig_ev FROM public.mf_loan_events e
     WHERE e.loan_id = ev.loan_id AND e.event_type = 'loan_disbursed'
       AND e.payload->>'disbursement_id' = ev.payload->>'disbursement_id'
     ORDER BY e.event_at DESC LIMIT 1;
    IF v_orig_ev IS NULL THEN
      RAISE EXCEPTION 'No original disbursement posting found';
    END IF;
    SELECT journal_entry_id INTO v_orig_je FROM public.mf_event_postings WHERE loan_event_id = v_orig_ev;
    IF v_orig_je IS NULL THEN
      RAISE EXCEPTION 'The disbursement was never posted; nothing to reverse';
    END IF;
    v_je := public.void_journal_entry_atomic(v_orig_je,
      format('Reversal of disbursement of loan %s', l.loan_number), COALESCE(ev.actor_id, auth.uid()), NULL, COALESCE((ev.payload->>'effective_on')::date, ev.event_at::date, CURRENT_DATE));
    INSERT INTO public.mf_event_postings (business_id, loan_event_id, journal_entry_id, posting_kind)
    VALUES (ev.business_id, ev.id, v_je, 'reversal');
    RETURN v_je;

  ELSIF ev.event_type = 'loan_written_off' THEN
    v_principal := COALESCE((ev.payload->>'principal_written_off')::numeric, 0);
    v_interest  := COALESCE((ev.payload->>'interest_written_off')::numeric, 0);
    IF v_principal + v_interest <= 0 THEN
      RAISE EXCEPTION 'Loan % has nothing outstanding to write off', l.loan_number;
    END IF;
    -- Income is recognised when collected, so unpaid interest was never
    -- accrued into interest receivable and is NOT a balance-sheet asset.
    -- Only principal may be de-recognised through the GL; unpaid interest is
    -- a portfolio de-recognition recorded on the description only.
    IF v_principal <= 0 THEN
      RETURN NULL;
    END IF;
    v_desc := format('Write-off of loan %s: %s', l.loan_number, COALESCE(ev.payload->>'reason',''))
              || CASE WHEN v_interest > 0
                      THEN format(' (unpaid interest %s de-recognised in portfolio only)', v_interest)
                      ELSE '' END;
    v_ref  := l.loan_number;
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', public.mf_resolve_account(ev.business_id, l.branch_id, 'write_off_expense'),
                         'debit', v_principal, 'credit', 0, 'description', v_desc),
      jsonb_build_object('account_id', public.mf_resolve_account(ev.business_id, l.branch_id, 'principal_receivable'),
                         'debit', 0, 'credit', v_principal, 'description', v_desc || ' - principal'));

  ELSE
    RETURN NULL;
  END IF;

  v_je := public.post_journal_entry_atomic(
    _org_id         => v_org,
    _business_id    => ev.business_id,
    _entry_number   => NULL,
    _entry_date     => COALESCE(
                         (ev.payload->>'paid_on')::date,
                         (ev.payload->>'disbursed_on')::date,
                         (ev.payload->>'settled_on')::date,
                         (ev.payload->>'written_off_on')::date,
                         (ev.payload->>'effective_on')::date,
                         ev.event_at::date, CURRENT_DATE),
    _reference      => v_ref,
    _description    => v_desc,
    _source_type    => 'mf_loan_event',
    _source_id      => ev.id,
    _created_by     => COALESCE(ev.actor_id, auth.uid()),
    _is_closing     => false,
    _is_adjusting   => false,
    _lines          => v_lines,
    _currency       => COALESCE(l.currency_code,
                                (SELECT b.base_currency FROM public.businesses b WHERE b.id = ev.business_id)),
    _exchange_rate  => 1::numeric,
    _source_subtype => ev.event_type,
    _branch_id      => l.branch_id,
    _is_opening_entry => false,
    _amounts_in_document_currency => false);

  INSERT INTO public.mf_event_postings (business_id, loan_event_id, journal_entry_id, posting_kind)
  VALUES (ev.business_id, ev.id, v_je, v_kind);

  RETURN v_je;
END; $function$;
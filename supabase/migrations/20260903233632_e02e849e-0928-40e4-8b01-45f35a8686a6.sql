CREATE UNIQUE INDEX IF NOT EXISTS mf_repayments_loan_reference_uniq
  ON public.mf_repayments (business_id, loan_id, reference)
  WHERE reference IS NOT NULL AND btrim(reference) <> '' AND status <> 'reversed';

CREATE OR REPLACE FUNCTION public.mf_record_repayment(p_loan_id uuid, p_paid_on date, p_amount numeric, p_method text, p_reference text DEFAULT NULL::text, p_batch_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_loan public.mf_loans%ROWTYPE;
  v_order text[];
  v_remaining numeric(18,2) := ROUND(p_amount, 2);
  v_repayment_id uuid;
  v_receipt text;
  v_seq bigint;
  v_prefix text;
  v_attempt integer := 0;
  v_component text;
  v_inst RECORD;
  v_take numeric(18,2);
  v_avail numeric(18,2);
  v_event_id uuid;
  v_credit numeric(18,2) := 0;
  v_credit_used numeric(18,2) := 0;
  v_paid_on date := COALESCE(p_paid_on, CURRENT_DATE);
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'The repayment amount must be greater than zero.';
  END IF;

  SELECT * INTO v_loan FROM public.mf_loans WHERE id = p_loan_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That loan does not exist.';
  END IF;
  IF NOT user_has_business_access(auth.uid(), v_loan.business_id) THEN
    RAISE EXCEPTION 'You do not have permission to perform this action.';
  END IF;
  IF v_loan.status <> 'active' THEN
    RAISE EXCEPTION 'Only a disbursed, active loan can take a repayment (this loan is %).', v_loan.status;
  END IF;

  IF p_reference IS NOT NULL AND btrim(p_reference) <> '' AND EXISTS (
       SELECT 1 FROM public.mf_repayments
        WHERE business_id = v_loan.business_id AND loan_id = v_loan.id
          AND reference = p_reference AND status <> 'reversed') THEN
    RAISE EXCEPTION 'A receipt with reference % has already been recorded on this loan.', p_reference;
  END IF;

  SELECT allocation_order INTO v_order
  FROM public.mf_allocation_policy WHERE business_id = v_loan.business_id;
  IF v_order IS NULL THEN
    v_order := ARRAY['penalty','fee','interest','principal']::text[];
  END IF;

  -- Receipt number: highest existing number for this institution and month, +1.
  v_prefix := 'RCP-' || to_char(v_paid_on, 'YYYYMM') || '-';
  LOOP
    v_attempt := v_attempt + 1;
    SELECT COALESCE(MAX(NULLIF(regexp_replace(right(receipt_number, 5), '\D', '', 'g'), '')::bigint), 0) + v_attempt
      INTO v_seq
      FROM public.mf_repayments
     WHERE business_id = v_loan.business_id AND receipt_number LIKE v_prefix || '%';
    v_receipt := v_prefix || lpad(v_seq::text, 5, '0');
    BEGIN
      INSERT INTO public.mf_repayments (
        business_id, branch_id, batch_id, loan_id, client_id, receipt_number,
        paid_on, amount, method, reference, notes, received_by, created_by
      ) VALUES (
        v_loan.business_id, v_loan.branch_id, p_batch_id, v_loan.id, v_loan.client_id, v_receipt,
        v_paid_on, ROUND(p_amount, 2), p_method, p_reference, p_notes,
        auth.uid(), auth.uid()
      ) RETURNING id INTO v_repayment_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF v_attempt >= 25 THEN RAISE; END IF;
    END;
  END LOOP;

  -- Credit held from earlier overpayments on this loan is spent first.
  -- Reversed receipts never contribute credit.
  SELECT ROUND(COALESCE(SUM(a.amount), 0), 2) INTO v_credit
  FROM public.mf_repayment_allocations a
  JOIN public.mf_repayments r ON r.id = a.repayment_id
  WHERE a.loan_id = p_loan_id AND a.component = 'advance'
    AND a.repayment_id <> v_repayment_id
    AND r.status <> 'reversed';
  IF v_credit < 0 THEN v_credit := 0; END IF;
  v_remaining := v_remaining + v_credit;

  FOR v_inst IN
    SELECT * FROM public.mf_loan_installment_status
    WHERE loan_id = p_loan_id AND total_outstanding > 0
    ORDER BY installment_no
  LOOP
    EXIT WHEN v_remaining <= 0;
    FOREACH v_component IN ARRAY v_order LOOP
      EXIT WHEN v_remaining <= 0;
      v_avail := CASE v_component
        WHEN 'penalty' THEN 0
        WHEN 'fee' THEN v_inst.fees_outstanding
        WHEN 'interest' THEN v_inst.interest_outstanding
        WHEN 'principal' THEN v_inst.principal_outstanding
        ELSE 0 END;
      IF v_avail IS NULL OR v_avail <= 0 THEN CONTINUE; END IF;
      v_take := LEAST(v_avail, v_remaining);
      INSERT INTO public.mf_repayment_allocations (
        business_id, repayment_id, loan_id, installment_no, component, amount
      ) VALUES (
        v_loan.business_id, v_repayment_id, v_loan.id, v_inst.installment_no, v_component, v_take
      );
      v_remaining := v_remaining - v_take;
    END LOOP;
  END LOOP;

  v_credit_used := LEAST(v_credit, GREATEST(v_credit - v_remaining, 0));
  IF v_credit_used > 0 THEN
    INSERT INTO public.mf_repayment_allocations (
      business_id, repayment_id, loan_id, installment_no, component, amount
    ) VALUES (v_loan.business_id, v_repayment_id, v_loan.id, NULL, 'advance', -v_credit_used);
  END IF;

  IF v_remaining > 0 THEN
    INSERT INTO public.mf_repayment_allocations (
      business_id, repayment_id, loan_id, installment_no, component, amount
    ) VALUES (v_loan.business_id, v_repayment_id, v_loan.id, NULL, 'advance', v_remaining - (v_credit - v_credit_used));
  END IF;

  INSERT INTO public.mf_loan_events (business_id, loan_id, event_type, actor_id, amount, payload)
  VALUES (v_loan.business_id, v_loan.id, 'repayment_recorded', auth.uid(), ROUND(p_amount, 2),
    jsonb_build_object('repayment_id', v_repayment_id, 'receipt_number', v_receipt,
                       'method', p_method, 'reference', p_reference, 'paid_on', v_paid_on,
                       'batch_id', p_batch_id))
  RETURNING id INTO v_event_id;

  PERFORM public.mf_post_event(v_event_id);

  IF NOT EXISTS (
    SELECT 1 FROM public.mf_loan_installment_status
     WHERE loan_id = p_loan_id AND total_outstanding > 0
  ) THEN
    UPDATE public.mf_loans
       SET status = 'closed', closed_at = now(), updated_at = now()
     WHERE id = p_loan_id AND status = 'active';
  END IF;

  RETURN v_repayment_id;
END;
$function$;
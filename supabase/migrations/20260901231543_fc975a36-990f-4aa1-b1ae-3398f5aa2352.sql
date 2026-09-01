-- Outstanding per installment, derived from schedule vs posted allocations
CREATE OR REPLACE VIEW public.mf_loan_installment_status AS
SELECT
  s.business_id,
  s.loan_id,
  s.installment_no,
  s.due_date,
  s.principal_due,
  s.interest_due,
  s.fees_due,
  s.total_due,
  COALESCE(a.principal_paid, 0) AS principal_paid,
  COALESCE(a.interest_paid, 0) AS interest_paid,
  COALESCE(a.fees_paid, 0) AS fees_paid,
  s.principal_due - COALESCE(a.principal_paid, 0) AS principal_outstanding,
  s.interest_due - COALESCE(a.interest_paid, 0) AS interest_outstanding,
  s.fees_due - COALESCE(a.fees_paid, 0) AS fees_outstanding,
  s.total_due - COALESCE(a.principal_paid, 0) - COALESCE(a.interest_paid, 0)
    - COALESCE(a.fees_paid, 0) AS total_outstanding
FROM public.mf_loan_schedule s
LEFT JOIN LATERAL (
  SELECT
    SUM(al.amount) FILTER (WHERE al.component = 'principal') AS principal_paid,
    SUM(al.amount) FILTER (WHERE al.component = 'interest') AS interest_paid,
    SUM(al.amount) FILTER (WHERE al.component IN ('fee','penalty')) AS fees_paid
  FROM public.mf_repayment_allocations al
  JOIN public.mf_repayments r ON r.id = al.repayment_id AND r.status = 'posted'
  WHERE al.loan_id = s.loan_id AND al.installment_no = s.installment_no
) a ON true;

GRANT SELECT ON public.mf_loan_installment_status TO authenticated;

-- Loan level balances and arrears
CREATE OR REPLACE VIEW public.mf_loan_balances AS
SELECT
  l.id AS loan_id,
  l.business_id,
  l.branch_id,
  l.client_id,
  l.loan_officer_id,
  l.loan_number,
  l.status,
  l.currency_code,
  l.principal,
  COALESCE(SUM(i.principal_outstanding), 0) AS principal_outstanding,
  COALESCE(SUM(i.interest_outstanding), 0) AS interest_outstanding,
  COALESCE(SUM(i.fees_outstanding), 0) AS fees_outstanding,
  COALESCE(SUM(i.total_outstanding), 0) AS total_outstanding,
  COALESCE(SUM(i.total_due), 0) AS total_contractual,
  COALESCE(SUM(i.total_outstanding) FILTER (WHERE i.due_date < CURRENT_DATE), 0) AS amount_overdue,
  COALESCE(
    MAX(CURRENT_DATE - i.due_date) FILTER (WHERE i.due_date < CURRENT_DATE AND i.total_outstanding > 0),
    0
  ) AS days_past_due,
  MIN(i.due_date) FILTER (WHERE i.total_outstanding > 0) AS next_due_date
FROM public.mf_loans l
LEFT JOIN public.mf_loan_installment_status i ON i.loan_id = l.id
GROUP BY l.id;

GRANT SELECT ON public.mf_loan_balances TO authenticated;

-- ============ record a repayment ============
CREATE OR REPLACE FUNCTION public.mf_record_repayment(
  p_loan_id uuid,
  p_paid_on date,
  p_amount numeric,
  p_method text,
  p_reference text DEFAULT NULL,
  p_batch_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_loan public.mf_loans%ROWTYPE;
  v_order text[];
  v_remaining numeric(18,2) := ROUND(p_amount, 2);
  v_repayment_id uuid;
  v_receipt text;
  v_seq bigint;
  v_component text;
  v_inst RECORD;
  v_take numeric(18,2);
  v_avail numeric(18,2);
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

  SELECT allocation_order INTO v_order
  FROM public.mf_allocation_policy WHERE business_id = v_loan.business_id;
  IF v_order IS NULL THEN
    v_order := ARRAY['penalty','fee','interest','principal']::text[];
  END IF;

  SELECT COUNT(*) + 1 INTO v_seq FROM public.mf_repayments WHERE business_id = v_loan.business_id;
  v_receipt := 'RCP-' || to_char(COALESCE(p_paid_on, CURRENT_DATE), 'YYYYMM') || '-' || lpad(v_seq::text, 5, '0');

  INSERT INTO public.mf_repayments (
    business_id, branch_id, batch_id, loan_id, client_id, receipt_number,
    paid_on, amount, method, reference, notes, received_by, created_by
  ) VALUES (
    v_loan.business_id, v_loan.branch_id, p_batch_id, v_loan.id, v_loan.client_id, v_receipt,
    COALESCE(p_paid_on, CURRENT_DATE), ROUND(p_amount, 2), p_method, p_reference, p_notes,
    auth.uid(), auth.uid()
  ) RETURNING id INTO v_repayment_id;

  -- Oldest installment first; within an installment follow the configured order.
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

  IF v_remaining > 0 THEN
    INSERT INTO public.mf_repayment_allocations (
      business_id, repayment_id, loan_id, installment_no, component, amount
    ) VALUES (v_loan.business_id, v_repayment_id, v_loan.id, NULL, 'advance', v_remaining);
  END IF;

  INSERT INTO public.mf_loan_events (business_id, loan_id, event_type, actor_id, amount, payload)
  VALUES (v_loan.business_id, v_loan.id, 'repayment_recorded', auth.uid(), ROUND(p_amount, 2),
    jsonb_build_object('repayment_id', v_repayment_id, 'receipt_number', v_receipt, 'method', p_method));

  -- Close the loan when nothing contractual remains outstanding.
  IF NOT EXISTS (
    SELECT 1 FROM public.mf_loan_installment_status
    WHERE loan_id = p_loan_id AND total_outstanding > 0.004
  ) THEN
    UPDATE public.mf_loans SET status = 'closed', closed_at = now() WHERE id = p_loan_id;
    INSERT INTO public.mf_loan_events (business_id, loan_id, event_type, actor_id, payload)
    VALUES (v_loan.business_id, v_loan.id, 'loan_closed', auth.uid(),
      jsonb_build_object('reason', 'fully_repaid'));
  END IF;

  RETURN v_repayment_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.mf_record_repayment(uuid, date, numeric, text, text, uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.mf_record_repayment(uuid, date, numeric, text, text, uuid, text) TO authenticated;

-- ============ reverse a repayment ============
CREATE OR REPLACE FUNCTION public.mf_reverse_repayment(
  p_repayment_id uuid,
  p_reason text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rep public.mf_repayments%ROWTYPE;
BEGIN
  SELECT * INTO v_rep FROM public.mf_repayments WHERE id = p_repayment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That receipt does not exist.';
  END IF;
  IF NOT user_has_business_access(auth.uid(), v_rep.business_id)
     OR NOT (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin')
             OR has_role(auth.uid(),'branch_manager')) THEN
    RAISE EXCEPTION 'You do not have permission to reverse a receipt.';
  END IF;
  IF v_rep.status = 'reversed' THEN
    RAISE EXCEPTION 'That receipt has already been reversed.';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reversal reason is required.';
  END IF;

  DELETE FROM public.mf_repayment_allocations WHERE repayment_id = p_repayment_id;

  UPDATE public.mf_repayments
  SET status = 'reversed', reversal_reason = p_reason, reversed_at = now(), reversed_by = auth.uid()
  WHERE id = p_repayment_id;

  UPDATE public.mf_loans
  SET status = 'active', closed_at = NULL
  WHERE id = v_rep.loan_id AND status = 'closed';

  INSERT INTO public.mf_loan_events (business_id, loan_id, event_type, actor_id, amount, payload)
  VALUES (v_rep.business_id, v_rep.loan_id, 'repayment_reversed', auth.uid(), v_rep.amount,
    jsonb_build_object('repayment_id', p_repayment_id, 'receipt_number', v_rep.receipt_number,
                       'reason', p_reason));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.mf_reverse_repayment(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.mf_reverse_repayment(uuid, text) TO authenticated;
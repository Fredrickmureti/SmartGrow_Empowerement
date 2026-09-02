ALTER TABLE public.mf_account_mappings DROP CONSTRAINT mf_account_mappings_key_valid;
ALTER TABLE public.mf_account_mappings ADD CONSTRAINT mf_account_mappings_key_valid CHECK (mapping_key = ANY (ARRAY['principal_receivable','interest_income','interest_receivable','fee_income','penalty_income','cash','bank','mobile_money','write_off_expense','loan_loss_provision','suspended_interest','client_advance']));

CREATE OR REPLACE FUNCTION public.mf_post_event(p_event_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
    v_cash_key := public.mf_method_mapping_key(ev.payload->>'method');
    v_desc := format('Loan disbursement %s', l.loan_number);
    v_ref  := COALESCE(ev.payload->>'reference', l.loan_number);
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', public.mf_resolve_account(ev.business_id, l.branch_id, 'principal_receivable'),
                         'debit', ev.amount, 'credit', 0, 'description', v_desc),
      jsonb_build_object('account_id', public.mf_resolve_account(ev.business_id, l.branch_id, v_cash_key),
                         'debit', 0, 'credit', ev.amount, 'description', v_desc));

  ELSIF ev.event_type = 'repayment_recorded' THEN
    v_cash_key := public.mf_method_mapping_key(ev.payload->>'method');
    v_desc := format('Loan repayment %s receipt %s', l.loan_number, COALESCE(ev.payload->>'receipt_number',''));
    v_ref  := COALESCE(ev.payload->>'receipt_number', l.loan_number);
    v_lines := v_lines || jsonb_build_object(
      'account_id', public.mf_resolve_account(ev.business_id, l.branch_id, v_cash_key),
      'debit', ev.amount, 'credit', 0, 'description', v_desc);
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
        'debit', 0, 'credit', r.amount, 'description', v_desc || ' - ' || r.component);
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
    SELECT journal_entry_id INTO v_orig_je FROM public.mf_event_postings WHERE loan_event_id = v_orig_ev;
    IF v_orig_je IS NULL THEN
      RAISE EXCEPTION 'Original receipt posting not found; cannot reverse in the ledger';
    END IF;
    v_desc := format('Reversal of receipt %s: %s', COALESCE(ev.payload->>'receipt_number',''), COALESCE(ev.payload->>'reason',''));
    v_ref  := COALESCE(ev.payload->>'receipt_number', l.loan_number);
    SELECT jsonb_agg(jsonb_build_object('account_id', jl.account_id, 'debit', jl.credit, 'credit', jl.debit,
                                        'description', v_desc) ORDER BY jl.sort_order)
      INTO v_lines
      FROM public.journal_entry_lines jl WHERE jl.journal_entry_id = v_orig_je;

  ELSE
    RAISE EXCEPTION 'No accounting treatment defined for event type %', ev.event_type;
  END IF;

  v_je := public.post_journal_entry_atomic(
    v_org, ev.business_id, NULL,
    COALESCE((ev.payload->>'disbursed_on')::date, (ev.payload->>'paid_on')::date, ev.event_at::date),
    v_ref, v_desc,
    'mf_loan_event', ev.id, ev.actor_id,
    false, false, v_lines,
    l.currency_code, NULL, v_kind, l.branch_id);

  INSERT INTO public.mf_event_postings (business_id, loan_event_id, journal_entry_id, posting_kind)
  VALUES (ev.business_id, ev.id, v_je, v_kind);

  RETURN v_je;
END;
$function$;

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
  v_component text;
  v_inst RECORD;
  v_take numeric(18,2);
  v_avail numeric(18,2);
  v_event_id uuid;
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
    jsonb_build_object('repayment_id', v_repayment_id, 'receipt_number', v_receipt,
                       'method', p_method, 'paid_on', COALESCE(p_paid_on, CURRENT_DATE)))
  RETURNING id INTO v_event_id;

  PERFORM public.mf_post_event(v_event_id);

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
$function$;

CREATE OR REPLACE FUNCTION public.mf_reverse_repayment(p_repayment_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rep public.mf_repayments%ROWTYPE;
  v_event_id uuid;
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

  -- Allocations are history: balances already exclude reversed receipts.
  UPDATE public.mf_repayments
  SET status = 'reversed', reversal_reason = p_reason, reversed_at = now(), reversed_by = auth.uid()
  WHERE id = p_repayment_id;

  UPDATE public.mf_loans
  SET status = 'active', closed_at = NULL
  WHERE id = v_rep.loan_id AND status = 'closed';

  INSERT INTO public.mf_loan_events (business_id, loan_id, event_type, actor_id, amount, payload)
  VALUES (v_rep.business_id, v_rep.loan_id, 'repayment_reversed', auth.uid(), v_rep.amount,
    jsonb_build_object('repayment_id', p_repayment_id, 'receipt_number', v_rep.receipt_number,
                       'reason', p_reason))
  RETURNING id INTO v_event_id;

  PERFORM public.mf_post_event(v_event_id);
END;
$function$;
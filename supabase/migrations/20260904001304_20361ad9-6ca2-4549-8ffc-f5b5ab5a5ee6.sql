-- 1. mf_post_event: restore write-off posting, add disbursement reversal posting
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
  v_principal numeric;
  v_interest  numeric;
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
    v_je := public.reverse_journal_entry_atomic(v_orig_je,
      format('Reversal of repayment %s', COALESCE(ev.payload->>'receipt_number','')));
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
    v_je := public.reverse_journal_entry_atomic(v_orig_je,
      format('Reversal of disbursement of loan %s', l.loan_number));
    INSERT INTO public.mf_event_postings (business_id, loan_event_id, journal_entry_id, posting_kind)
    VALUES (ev.business_id, ev.id, v_je, 'reversal');
    RETURN v_je;

  ELSIF ev.event_type = 'loan_written_off' THEN
    v_principal := COALESCE((ev.payload->>'principal_written_off')::numeric, 0);
    v_interest  := COALESCE((ev.payload->>'interest_written_off')::numeric, 0);
    IF v_principal + v_interest <= 0 THEN
      RAISE EXCEPTION 'Loan % has nothing outstanding to write off', l.loan_number;
    END IF;
    v_desc := format('Write-off of loan %s: %s', l.loan_number, COALESCE(ev.payload->>'reason',''));
    v_ref  := l.loan_number;
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', public.mf_resolve_account(ev.business_id, l.branch_id, 'write_off_expense'),
                         'debit', v_principal + v_interest, 'credit', 0, 'description', v_desc));
    IF v_principal > 0 THEN
      v_lines := v_lines || jsonb_build_object(
        'account_id', public.mf_resolve_account(ev.business_id, l.branch_id, 'principal_receivable'),
        'debit', 0, 'credit', v_principal, 'description', v_desc || ' - principal');
    END IF;
    IF v_interest > 0 THEN
      v_lines := v_lines || jsonb_build_object(
        'account_id', public.mf_resolve_account(ev.business_id, l.branch_id, 'interest_receivable'),
        'debit', 0, 'credit', v_interest, 'description', v_desc || ' - interest');
    END IF;

  ELSE
    RETURN NULL;
  END IF;

  v_je := public.post_journal_entry_atomic(
    v_org, ev.business_id, l.branch_id, COALESCE(ev.event_at::date, CURRENT_DATE),
    v_desc, v_ref, v_lines);

  INSERT INTO public.mf_event_postings (business_id, loan_event_id, journal_entry_id, posting_kind)
  VALUES (ev.business_id, ev.id, v_je, v_kind);

  RETURN v_je;
END;
$function$;

-- 2. Controlled disbursement reversal
CREATE OR REPLACE FUNCTION public.mf_reverse_disbursement(p_disbursement_id uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  d public.mf_loan_disbursements%ROWTYPE;
  l public.mf_loans%ROWTYPE;
  v_shift integer;
  v_ev uuid;
BEGIN
  SELECT * INTO d FROM public.mf_loan_disbursements WHERE id = p_disbursement_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'That disbursement does not exist.'; END IF;
  IF d.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'That disbursement has already been reversed.';
  END IF;
  IF COALESCE(BTRIM(p_reason), '') = '' THEN
    RAISE EXCEPTION 'A reversal reason is required.';
  END IF;

  SELECT * INTO l FROM public.mf_loans WHERE id = d.loan_id FOR UPDATE;
  IF NOT user_has_business_access(auth.uid(), l.business_id) THEN
    RAISE EXCEPTION 'You do not have permission to perform this action.';
  END IF;
  IF NOT (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin')
       OR has_role(auth.uid(),'branch_manager')) THEN
    RAISE EXCEPTION 'You are not authorised to reverse a disbursement.';
  END IF;
  IF l.status <> 'active' THEN
    RAISE EXCEPTION 'Only an active loan can have its disbursement reversed (this loan is %).', l.status;
  END IF;
  IF EXISTS (SELECT 1 FROM public.mf_repayments
              WHERE loan_id = l.id AND status <> 'reversed') THEN
    RAISE EXCEPTION 'Reverse the receipts on this loan before reversing the disbursement.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.mf_loan_charges
              WHERE loan_id = l.id AND reversed_at IS NULL) THEN
    RAISE EXCEPTION 'This loan carries charges; reverse them before reversing the disbursement.';
  END IF;
  IF l.parent_loan_id IS NOT NULL THEN
    RAISE EXCEPTION 'This disbursement settled loan %; a replacement disbursement cannot be reversed.',
      (SELECT loan_number FROM public.mf_loans WHERE id = l.parent_loan_id);
  END IF;

  UPDATE public.mf_loan_disbursements
     SET reversed_at = now(), reversed_by = auth.uid(), reversal_reason = BTRIM(p_reason)
   WHERE id = d.id;

  -- Put the contractual schedule back where it was before the disbursement date shift
  IF l.expected_disbursement_date IS DISTINCT FROM d.disbursed_on THEN
    v_shift := d.disbursed_on - l.expected_disbursement_date;
    UPDATE public.mf_loan_schedule SET due_date = due_date - v_shift, updated_at = now()
     WHERE loan_id = l.id;
  END IF;

  UPDATE public.mf_loans
     SET status = 'pending_disbursement', disbursed_at = NULL,
         first_installment_date = (SELECT MIN(due_date) FROM public.mf_loan_schedule WHERE loan_id = l.id),
         updated_at = now()
   WHERE id = l.id;

  IF l.application_id IS NOT NULL THEN
    UPDATE public.mf_loan_applications SET status = 'approved', updated_at = now()
     WHERE id = l.application_id;
  END IF;

  INSERT INTO public.mf_loan_events (business_id, loan_id, event_type, actor_id, amount, payload)
  VALUES (l.business_id, l.id, 'disbursement_reversed', auth.uid(), d.amount,
          jsonb_build_object('disbursement_id', d.id, 'reason', BTRIM(p_reason),
                             'disbursed_on', d.disbursed_on, 'method', d.method))
  RETURNING id INTO v_ev;

  PERFORM public.mf_post_event(v_ev);

  RETURN v_ev;
END;
$function$;

REVOKE ALL ON FUNCTION public.mf_reverse_disbursement(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mf_reverse_disbursement(uuid, text) TO authenticated;

-- 3. Lock the receipt while reversing it
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
  SELECT * INTO v_rep FROM public.mf_repayments WHERE id = p_repayment_id FOR UPDATE;
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

-- 4. Group membership follows the group's officer scope
DROP POLICY IF EXISTS mf_group_members_read ON public.mf_group_members;
CREATE POLICY mf_group_members_read ON public.mf_group_members
FOR SELECT TO authenticated
USING (
  user_has_business_access(auth.uid(), business_id)
  AND EXISTS (
    SELECT 1 FROM public.mf_groups g
     WHERE g.id = mf_group_members.group_id
       AND public.mf_officer_in_scope(g.loan_officer_id)
  )
);
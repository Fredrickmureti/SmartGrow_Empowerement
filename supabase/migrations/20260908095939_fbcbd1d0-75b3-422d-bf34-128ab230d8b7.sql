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
  v_fees      numeric;
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
    v_fees := ROUND(COALESCE((ev.payload->>'fees_deducted')::numeric, 0), 2);
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
    v_lines := v_lines || jsonb_build_object(
      'account_id', public.mf_resolve_account(ev.business_id, l.branch_id, v_cash_key),
      'debit', 0, 'credit', ROUND(ev.amount, 2) - v_fees,
      'description', v_desc || CASE WHEN v_fees > 0 THEN ' - net paid out' ELSE '' END);

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
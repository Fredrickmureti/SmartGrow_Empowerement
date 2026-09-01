CREATE OR REPLACE FUNCTION public.mf_post_event(p_event_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  ev        public.mf_loan_events%ROWTYPE;
  l         public.mf_loans%ROWTYPE;
  v_org     uuid;
  v_je      uuid;
  v_lines   jsonb := '[]'::jsonb;
  v_desc    text;
  v_ref     text;
  v_kind    text := 'original';
  v_method  text;
  v_cash_key text;
  v_amt     numeric;
  v_orig_je uuid;
  v_orig_ev uuid;
  r         record;

  -- resolve a mapping key to an account id; branch override first, then institution-wide
  FUNCTION_PLACEHOLDER text;
BEGIN
  SELECT * INTO ev FROM public.mf_loan_events WHERE id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan event % not found', p_event_id; END IF;

  -- idempotent: already posted
  SELECT journal_entry_id INTO v_je FROM public.mf_event_postings WHERE loan_event_id = p_event_id;
  IF v_je IS NOT NULL THEN RETURN v_je; END IF;

  SELECT * INTO l FROM public.mf_loans WHERE id = ev.loan_id;
  SELECT organization_id INTO v_org FROM public.businesses WHERE id = ev.business_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Institution % has no organization', ev.business_id; END IF;

  IF ev.event_type = 'loan_disbursed' THEN
    v_method := ev.payload->>'method';
    v_cash_key := public.mf_method_mapping_key(v_method);
    v_amt := ev.amount;
    v_desc := format('Loan disbursement %s', l.loan_number);
    v_ref  := COALESCE(ev.payload->>'reference', l.loan_number);
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', public.mf_resolve_account(ev.business_id, l.branch_id, 'principal_receivable'),
                         'debit', v_amt, 'credit', 0, 'description', v_desc),
      jsonb_build_object('account_id', public.mf_resolve_account(ev.business_id, l.branch_id, v_cash_key),
                         'debit', 0, 'credit', v_amt, 'description', v_desc));

  ELSIF ev.event_type = 'repayment_recorded' THEN
    v_method := ev.payload->>'method';
    v_cash_key := public.mf_method_mapping_key(v_method);
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
            ELSE NULL END),
        'debit', 0, 'credit', r.amount, 'description', v_desc || ' — ' || r.component);
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
    v_org, ev.business_id, NULL, COALESCE((ev.payload->>'disbursed_on')::date, (ev.payload->>'paid_on')::date, ev.event_at::date),
    v_ref, v_desc,
    'mf_loan_event', ev.id, ev.actor_id,
    false, false, v_lines,
    l.currency_code, NULL, v_kind, l.branch_id);

  INSERT INTO public.mf_event_postings (business_id, loan_event_id, journal_entry_id, posting_kind)
  VALUES (ev.business_id, ev.id, v_je, v_kind);

  RETURN v_je;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.mf_post_event(uuid) FROM PUBLIC, anon, authenticated;
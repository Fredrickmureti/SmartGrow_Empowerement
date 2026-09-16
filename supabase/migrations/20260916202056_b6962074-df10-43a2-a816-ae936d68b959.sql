-- 1. Traceability + reversibility on interest recognition rows
ALTER TABLE public.mf_deferred_interest_releases
  ADD COLUMN IF NOT EXISTS repayment_id uuid REFERENCES public.mf_repayments(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by uuid,
  ADD COLUMN IF NOT EXISTS reversal_event_id uuid REFERENCES public.mf_loan_events(id) ON DELETE RESTRICT;

ALTER TABLE public.mf_deferred_interest_releases
  DROP CONSTRAINT IF EXISTS mf_deferred_interest_releases_loan_id_installment_no_key;

CREATE UNIQUE INDEX IF NOT EXISTS mf_deferred_interest_releases_live_uq
  ON public.mf_deferred_interest_releases (loan_id, installment_no)
  WHERE reversed_at IS NULL;

CREATE INDEX IF NOT EXISTS mf_deferred_interest_releases_repayment_idx
  ON public.mf_deferred_interest_releases (repayment_id)
  WHERE repayment_id IS NOT NULL;

-- 2. Recognition engine: optionally driven by settled instalments instead of due date
DROP FUNCTION IF EXISTS public.mf_release_deferred_interest(uuid, date, boolean);

CREATE OR REPLACE FUNCTION public.mf_release_deferred_interest(
  p_loan_id uuid,
  p_as_of date DEFAULT CURRENT_DATE,
  p_release_all boolean DEFAULT false,
  p_installments integer[] DEFAULT NULL,
  p_repayment_id uuid DEFAULT NULL)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  l public.mf_loans%ROWTYPE;
  d public.mf_loan_disbursements%ROWTYPE;
  v_total numeric(18,2);
  v_terms integer;
  v_share numeric(18,2);
  v_released numeric(18,2);
  v_amount numeric(18,2);
  v_sum numeric(18,2) := 0;
  v_acc uuid;
  v_ev uuid;
  v_paid_on date;
  v_effective date;
  r record;
BEGIN
  SELECT * INTO l FROM public.mf_loans WHERE id = p_loan_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found'; END IF;

  SELECT * INTO d FROM public.mf_loan_disbursements
   WHERE loan_id = p_loan_id AND reversed_at IS NULL
   ORDER BY disbursed_on DESC LIMIT 1;
  IF NOT FOUND THEN RETURN 0; END IF;

  v_total := ROUND(COALESCE(d.upfront_interest, 0), 2);
  IF v_total <= 0 THEN RETURN 0; END IF;

  SELECT COUNT(*) INTO v_terms FROM public.mf_loan_schedule WHERE loan_id = p_loan_id;
  IF COALESCE(v_terms, 0) = 0 THEN RETURN 0; END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_released
    FROM public.mf_deferred_interest_releases
   WHERE loan_id = p_loan_id AND reversed_at IS NULL;
  IF v_released >= v_total THEN RETURN 0; END IF;

  IF p_repayment_id IS NOT NULL THEN
    SELECT paid_on INTO v_paid_on FROM public.mf_repayments WHERE id = p_repayment_id;
  END IF;

  v_share := ROUND(v_total / v_terms, 2);
  v_acc   := public.mf_resolve_account(l.business_id, l.branch_id, 'deferred_interest');

  FOR r IN
    SELECT s.installment_no, s.due_date
      FROM public.mf_loan_schedule s
     WHERE s.loan_id = p_loan_id
       AND CASE
             WHEN p_installments IS NOT NULL THEN s.installment_no = ANY (p_installments)
             ELSE p_release_all OR s.due_date <= p_as_of
           END
       AND NOT EXISTS (SELECT 1 FROM public.mf_deferred_interest_releases x
                        WHERE x.loan_id = p_loan_id
                          AND x.installment_no = s.installment_no
                          AND x.reversed_at IS NULL)
     ORDER BY s.installment_no
  LOOP
    IF r.installment_no = v_terms THEN
      v_amount := ROUND(v_total - v_released, 2);
    ELSE
      v_amount := LEAST(v_share, ROUND(v_total - v_released, 2));
    END IF;
    IF v_amount <= 0 THEN CONTINUE; END IF;

    v_effective := GREATEST(COALESCE(v_paid_on, r.due_date), d.disbursed_on);

    INSERT INTO public.mf_loan_events (business_id, loan_id, event_type, actor_id, amount, payload)
    VALUES (l.business_id, l.id, 'deferred_interest_released', auth.uid(), v_amount,
            jsonb_build_object('installment_no', r.installment_no,
                               'effective_on', v_effective,
                               'disbursement_id', d.id,
                               'repayment_id', p_repayment_id))
    RETURNING id INTO v_ev;

    PERFORM public.mf_post_event(v_ev);

    INSERT INTO public.mf_deferred_interest_releases
      (business_id, loan_id, installment_no, amount, released_on, account_id, loan_event_id, repayment_id)
    VALUES (l.business_id, l.id, r.installment_no, v_amount,
            v_effective, v_acc, v_ev, p_repayment_id);

    v_released := v_released + v_amount;
    v_sum := v_sum + v_amount;
    EXIT WHEN v_released >= v_total;
  END LOOP;

  RETURN v_sum;
END; $function$;

-- 3. Scheduled runner only serves loans set to recognise on the due date
CREATE OR REPLACE FUNCTION public.mf_release_deferred_interest_due(p_business_id uuid, p_as_of date DEFAULT CURRENT_DATE)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_sum numeric(18,2) := 0; r record;
BEGIN
  IF NOT public.user_has_business_access(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'Not authorised for this institution';
  END IF;
  FOR r IN
    SELECT DISTINCT l.id
      FROM public.mf_loans l
      JOIN public.mf_loan_disbursements d ON d.loan_id = l.id AND d.reversed_at IS NULL
     WHERE l.business_id = p_business_id
       AND COALESCE(d.upfront_interest, 0) > 0
       AND COALESCE(l.interest_recognition, 'on_repayment') = 'on_schedule_date'
  LOOP
    v_sum := v_sum + public.mf_release_deferred_interest(r.id, p_as_of, false);
  END LOOP;
  RETURN v_sum;
END; $function$;

-- 4. Recognition driven by a receipt: only instalments the receipt has fully settled
CREATE OR REPLACE FUNCTION public.mf_recognise_repayment_interest(p_loan_id uuid, p_repayment_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  l public.mf_loans%ROWTYPE;
  v_list integer[];
BEGIN
  SELECT * INTO l FROM public.mf_loans WHERE id = p_loan_id;
  IF NOT FOUND THEN RETURN 0; END IF;
  IF COALESCE(l.interest_collection, 'with_installments') <> 'deducted_upfront' THEN RETURN 0; END IF;
  IF COALESCE(l.interest_recognition, 'on_repayment') <> 'on_repayment' THEN RETURN 0; END IF;

  SELECT array_agg(s.installment_no ORDER BY s.installment_no) INTO v_list
    FROM public.mf_loan_installment_status s
   WHERE s.loan_id = p_loan_id
     AND ROUND(COALESCE(s.total_outstanding, 0), 2) <= 0;

  IF v_list IS NULL THEN RETURN 0; END IF;

  RETURN public.mf_release_deferred_interest(p_loan_id, CURRENT_DATE, false, v_list, p_repayment_id);
END; $function$;

-- 5. Post the reversal of a recognition slice through the single posting path
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
    -- Interest collected at payout is cash held but not yet earned: unearned
    -- interest, released to income as the term runs.
    IF v_upfront > 0 THEN
      v_lines := v_lines || jsonb_build_object(
        'account_id', public.mf_resolve_account(ev.business_id, l.branch_id, 'deferred_interest'),
        'debit', 0, 'credit', v_upfront, 'description', v_desc || ' - interest collected upfront (unearned)');
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

  ELSIF ev.event_type = 'deferred_interest_released' THEN
    v_upfront := ROUND(COALESCE(ev.amount, 0), 2);
    IF v_upfront <= 0 THEN RETURN NULL; END IF;
    v_desc := format('Loan %s: unearned interest earned (instalment %s)',
                     l.loan_number, COALESCE(ev.payload->>'installment_no','-'));
    v_ref  := l.loan_number;
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', public.mf_resolve_account(ev.business_id, l.branch_id, 'deferred_interest'),
                         'debit', v_upfront, 'credit', 0, 'description', v_desc),
      jsonb_build_object('account_id', public.mf_resolve_account(ev.business_id, l.branch_id, 'interest_income'),
                         'debit', 0, 'credit', v_upfront, 'description', v_desc));

  ELSIF ev.event_type = 'deferred_interest_release_reversed' THEN
    v_kind := 'reversal';
    v_orig_ev := NULLIF(ev.payload->>'release_event_id','')::uuid;
    IF v_orig_ev IS NULL THEN
      RAISE EXCEPTION 'No original interest recognition referenced on event %', ev.id;
    END IF;
    SELECT journal_entry_id INTO v_orig_je FROM public.mf_event_postings WHERE loan_event_id = v_orig_ev;
    IF v_orig_je IS NULL THEN
      RAISE EXCEPTION 'That interest recognition was never posted; nothing to reverse';
    END IF;
    v_je := public.void_journal_entry_atomic(v_orig_je,
      format('Reversal of interest earned on loan %s (instalment %s)',
             l.loan_number, COALESCE(ev.payload->>'installment_no','-')),
      COALESCE(ev.actor_id, auth.uid()), NULL,
      COALESCE((ev.payload->>'effective_on')::date, ev.event_at::date, CURRENT_DATE));
    INSERT INTO public.mf_event_postings (business_id, loan_event_id, journal_entry_id, posting_kind)
    VALUES (ev.business_id, ev.id, v_je, 'reversal');
    RETURN v_je;

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
    -- Interest billed with instalments is income when collected, so unpaid
    -- interest was never an asset and only principal is de-recognised here.
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

-- 6. Recognise interest in the same transaction as the receipt
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

  SELECT * INTO v_loan FROM public.mf_loans WHERE id = p_loan_id FOR UPDATE;
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

  SELECT ROUND(COALESCE(SUM(a.amount), 0), 2) INTO v_credit
  FROM public.mf_repayment_allocations a
  JOIN public.mf_repayments r ON r.id = a.repayment_id
  WHERE a.loan_id = p_loan_id AND a.component = 'advance'
    AND a.repayment_id <> v_repayment_id
    AND r.status <> 'reversed';
  IF v_credit < 0 THEN v_credit := 0; END IF;
  v_remaining := v_remaining + v_credit;

  -- Oldest installment first, covering both scheduled amounts and any penalty
  -- raised on that installment (a penalty can sit on an otherwise settled one).
  FOR v_inst IN
    SELECT
      i.installment_no,
      COALESCE(s.fees_outstanding, 0)      AS fees_outstanding,
      COALESCE(s.interest_outstanding, 0)  AS interest_outstanding,
      COALESCE(s.principal_outstanding, 0) AS principal_outstanding,
      COALESCE(p.penalty_outstanding, 0)   AS penalty_outstanding
    FROM (
      SELECT installment_no FROM public.mf_loan_installment_status
        WHERE loan_id = p_loan_id AND total_outstanding > 0
      UNION
      SELECT installment_no FROM public.mf_loan_penalty_status
        WHERE loan_id = p_loan_id AND penalty_outstanding > 0
    ) i
    LEFT JOIN public.mf_loan_installment_status s
      ON s.loan_id = p_loan_id AND s.installment_no = i.installment_no
    LEFT JOIN public.mf_loan_penalty_status p
      ON p.loan_id = p_loan_id AND p.installment_no = i.installment_no
    ORDER BY i.installment_no
  LOOP
    EXIT WHEN v_remaining <= 0;
    FOREACH v_component IN ARRAY v_order LOOP
      EXIT WHEN v_remaining <= 0;
      v_avail := CASE v_component
        WHEN 'penalty' THEN v_inst.penalty_outstanding
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

  -- Interest withheld at payout is earned as the customer pays: the slice for
  -- every instalment this receipt has now settled is recognised here, in the
  -- same transaction, so the receipt and its income entry stand or fall together.
  PERFORM public.mf_recognise_repayment_interest(v_loan.id, v_repayment_id);

  IF NOT EXISTS (
    SELECT 1 FROM public.mf_loan_installment_status
     WHERE loan_id = p_loan_id AND total_outstanding > 0
  ) AND NOT EXISTS (
    SELECT 1 FROM public.mf_loan_penalty_status
     WHERE loan_id = p_loan_id AND penalty_outstanding > 0
  ) THEN
    UPDATE public.mf_loans
       SET status = 'closed', closed_at = now(), updated_at = now()
     WHERE id = p_loan_id AND status = 'active';
  END IF;

  RETURN v_repayment_id;
END;
$function$;

-- 7. Reversing a receipt unwinds the interest that receipt caused to be earned
CREATE OR REPLACE FUNCTION public.mf_reverse_repayment(p_repayment_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rep public.mf_repayments%ROWTYPE;
  v_event_id uuid;
  v_rel_ev uuid;
  rel record;
BEGIN
  SELECT * INTO v_rep FROM public.mf_repayments WHERE id = p_repayment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That receipt does not exist.';
  END IF;
  IF NOT user_has_business_access(auth.uid(), v_rep.business_id)
     OR NOT (has_role(auth.uid(),'admin')
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

  -- The income this receipt earned goes back out with it; the instalment then
  -- becomes eligible for recognition again once it is settled afresh.
  FOR rel IN
    SELECT * FROM public.mf_deferred_interest_releases
     WHERE repayment_id = p_repayment_id AND reversed_at IS NULL
     ORDER BY installment_no
     FOR UPDATE
  LOOP
    INSERT INTO public.mf_loan_events (business_id, loan_id, event_type, actor_id, amount, payload)
    VALUES (rel.business_id, rel.loan_id, 'deferred_interest_release_reversed', auth.uid(), rel.amount,
      jsonb_build_object('installment_no', rel.installment_no,
                         'release_id', rel.id,
                         'release_event_id', rel.loan_event_id,
                         'repayment_id', p_repayment_id,
                         'reason', p_reason))
    RETURNING id INTO v_rel_ev;

    PERFORM public.mf_post_event(v_rel_ev);

    UPDATE public.mf_deferred_interest_releases
       SET reversed_at = now(), reversed_by = auth.uid(), reversal_event_id = v_rel_ev
     WHERE id = rel.id;
  END LOOP;
END;
$function$;

-- 8. A payout cannot be unwound while interest recognised on it still stands
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
  IF NOT (has_role(auth.uid(),'admin')
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
  IF EXISTS (SELECT 1 FROM public.mf_deferred_interest_releases
              WHERE loan_id = l.id AND reversed_at IS NULL) THEN
    RAISE EXCEPTION 'Interest earned on this loan is still recognised; reverse it before reversing the disbursement.';
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
-- Loan fee engine: fee configuration on the product snapshot becomes real
-- money at disbursement. Principal is always recognised in full; a deducted
-- fee reduces only the cash paid out.

ALTER TABLE public.mf_loan_disbursements
  ADD COLUMN IF NOT EXISTS fees_deducted numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS net_amount numeric(18,2),
  ADD COLUMN IF NOT EXISTS fee_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE public.mf_loan_disbursements
   SET net_amount = amount
 WHERE net_amount IS NULL;

-- Resolve the fee schedule of a loan from its frozen product snapshot.
-- Supports the current shape {name, basis, value, collection} and the legacy
-- {type, value, timing:'upfront'} rows written before this migration.
CREATE OR REPLACE FUNCTION public.mf_compute_loan_fees(p_loan_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
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

CREATE OR REPLACE FUNCTION public.mf_loan_fee_total(p_loan_id uuid, p_collection text)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT ROUND(COALESCE(SUM((f->>'amount')::numeric), 0), 2)
    FROM jsonb_array_elements(public.mf_compute_loan_fees(p_loan_id)) f
   WHERE f->>'collection' = p_collection;
$function$;

-- Schedule: only fees collected with repayments belong on the schedule.
CREATE OR REPLACE FUNCTION public.mf_generate_schedule(p_loan_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  l public.mf_loans%ROWTYPE;
  v_rate numeric; v_ppy numeric; v_period_rate numeric;
  v_n integer; v_i integer; v_bal numeric; v_prin numeric; v_int numeric;
  v_flat_interest numeric; v_installment numeric; v_due date;
  v_first_fees numeric := 0; v_paying integer;
BEGIN
  SELECT * INTO l FROM public.mf_loans WHERE id = p_loan_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found'; END IF;
  IF l.status <> 'pending_disbursement' THEN
    RAISE EXCEPTION 'Schedule can only be generated before disbursement';
  END IF;

  DELETE FROM public.mf_loan_schedule WHERE loan_id = p_loan_id;

  v_ppy := public.mf_periods_per_year(l.repayment_frequency);
  v_rate := COALESCE(l.interest_rate, 0) / 100.0;
  v_period_rate := CASE
    WHEN l.interest_rate_period = 'per_period' THEN v_rate
    WHEN l.interest_rate_period = 'per_month' THEN v_rate * 12 / v_ppy
    ELSE v_rate / v_ppy END;

  v_n := l.term_installments;
  v_paying := GREATEST(v_n - COALESCE(l.grace_period_installments,0), 1);
  v_bal := l.principal;

  v_first_fees := public.mf_loan_fee_total(p_loan_id, 'added_to_first_installment');

  IF l.interest_method = 'flat' THEN
    v_flat_interest := ROUND(l.principal * v_period_rate * v_n, 2);
  END IF;

  IF l.interest_method = 'declining_balance' THEN
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
      v_int := CASE WHEN l.interest_method = 'declining_balance'
                 THEN ROUND(v_bal * v_period_rate, 2) ELSE 0 END;
    ELSIF l.interest_method = 'flat' THEN
      v_prin := ROUND(l.principal / v_paying, 2);
      v_int := ROUND(v_flat_interest / v_paying, 2);
      IF v_i = v_n THEN v_prin := v_bal; END IF;
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

-- Disbursement: gross principal is the contractual amount; deducted fees are
-- retained by the institution and only the net leaves the funding account.
CREATE OR REPLACE FUNCTION public.mf_disburse_loan(p_loan_id uuid, p_disbursed_on date, p_amount numeric, p_method text, p_reference text DEFAULT NULL::text, p_source_account_id uuid DEFAULT NULL::uuid, p_received_by_name text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  l public.mf_loans%ROWTYPE;
  p public.mf_loans%ROWTYPE;
  v_id uuid; v_shift integer; v_ev uuid; v_settle_ev uuid;
  v_carried numeric;
  v_fees jsonb; v_deducted numeric(18,2); v_net numeric(18,2);
BEGIN
  SELECT * INTO l FROM public.mf_loans WHERE id = p_loan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found'; END IF;
  IF NOT user_has_business_access(auth.uid(), l.business_id) THEN
    RAISE EXCEPTION 'Not authorised for this institution';
  END IF;
  IF NOT (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin')
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

  v_fees := public.mf_compute_loan_fees(p_loan_id);
  v_deducted := public.mf_loan_fee_total(p_loan_id, 'deducted_from_disbursement');
  v_net := ROUND(p_amount, 2) - v_deducted;
  IF v_net <= 0 THEN
    RAISE EXCEPTION 'Fees of % would leave nothing to pay out on a principal of %',
      v_deducted, ROUND(p_amount,2);
  END IF;

  INSERT INTO public.mf_loan_disbursements (
    business_id, loan_id, disbursed_on, amount, method, reference,
    source_account_id, received_by_name, notes, disbursed_by,
    fees_deducted, net_amount, fee_breakdown)
  VALUES (l.business_id, l.id, p_disbursed_on, p_amount, p_method, p_reference,
          p_source_account_id, p_received_by_name, p_notes, auth.uid(),
          v_deducted, v_net, v_fees)
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

-- Posting: DR principal receivable (gross) / CR fee income (deducted fees)
-- / CR funding account (net cash actually paid out).
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
END; $function$;

REVOKE ALL ON FUNCTION public.mf_compute_loan_fees(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.mf_loan_fee_total(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.mf_compute_loan_fees(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mf_loan_fee_total(uuid, text) TO authenticated;
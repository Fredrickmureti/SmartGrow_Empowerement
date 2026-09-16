-- 1. New mapping key
ALTER TABLE public.mf_account_mappings DROP CONSTRAINT IF EXISTS mf_account_mappings_key_valid;
ALTER TABLE public.mf_account_mappings ADD CONSTRAINT mf_account_mappings_key_valid
  CHECK (mapping_key = ANY (ARRAY['principal_receivable','interest_income','interest_receivable',
    'deferred_interest','fee_income','penalty_income','cash','bank','mobile_money',
    'write_off_expense','loan_loss_provision','suspended_interest','client_advance','cash_over_short']));

-- 2. Unearned interest account + mapping for every institution already configured for lending
DO $$
DECLARE r record; v_acc uuid;
BEGIN
  FOR r IN SELECT DISTINCT m.business_id, b.organization_id
             FROM public.mf_account_mappings m
             JOIN public.businesses b ON b.id = m.business_id
  LOOP
    SELECT id INTO v_acc FROM public.accounts
      WHERE business_id = r.business_id AND code = '2440' LIMIT 1;
    IF v_acc IS NULL THEN
      INSERT INTO public.accounts (organization_id, business_id, account_type, code, name, description, is_active)
      VALUES (r.organization_id, r.business_id, 'liability', '2440', 'Unearned Loan Interest',
              'Interest already collected from borrowers but not yet earned; released to interest income as the loan term runs.',
              true)
      RETURNING id INTO v_acc;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.mf_account_mappings
                    WHERE business_id = r.business_id AND mapping_key = 'deferred_interest'
                      AND branch_id IS NULL) THEN
      INSERT INTO public.mf_account_mappings (business_id, branch_id, mapping_key, account_id, notes)
      VALUES (r.business_id, NULL, 'deferred_interest', v_acc,
              'Interest collected upfront, held until earned.');
    END IF;
  END LOOP;
END $$;

-- 3. Release ledger
CREATE TABLE public.mf_deferred_interest_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  loan_id uuid NOT NULL REFERENCES public.mf_loans(id) ON DELETE RESTRICT,
  installment_no integer NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  released_on date NOT NULL,
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  loan_event_id uuid NOT NULL REFERENCES public.mf_loan_events(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loan_id, installment_no)
);

GRANT SELECT ON public.mf_deferred_interest_releases TO authenticated;
GRANT ALL ON public.mf_deferred_interest_releases TO service_role;
ALTER TABLE public.mf_deferred_interest_releases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Institution members can read deferred interest releases"
ON public.mf_deferred_interest_releases FOR SELECT TO authenticated
USING (public.user_has_business_access(auth.uid(), business_id));

-- 4. Posting: unearned interest at payout, released later
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

-- 5. Release routine: turn unearned interest into income as instalments fall due
CREATE OR REPLACE FUNCTION public.mf_release_deferred_interest(
  p_loan_id uuid, p_as_of date DEFAULT CURRENT_DATE, p_release_all boolean DEFAULT false)
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
    FROM public.mf_deferred_interest_releases WHERE loan_id = p_loan_id;
  IF v_released >= v_total THEN RETURN 0; END IF;

  v_share := ROUND(v_total / v_terms, 2);
  v_acc   := public.mf_resolve_account(l.business_id, l.branch_id, 'deferred_interest');

  FOR r IN
    SELECT s.installment_no, s.due_date
      FROM public.mf_loan_schedule s
     WHERE s.loan_id = p_loan_id
       AND (p_release_all OR s.due_date <= p_as_of)
       AND NOT EXISTS (SELECT 1 FROM public.mf_deferred_interest_releases x
                        WHERE x.loan_id = p_loan_id AND x.installment_no = s.installment_no)
     ORDER BY s.installment_no
  LOOP
    IF r.installment_no = v_terms THEN
      v_amount := ROUND(v_total - v_released, 2);
    ELSE
      v_amount := LEAST(v_share, ROUND(v_total - v_released, 2));
    END IF;
    IF v_amount <= 0 THEN CONTINUE; END IF;

    INSERT INTO public.mf_loan_events (business_id, loan_id, event_type, actor_id, amount, payload)
    VALUES (l.business_id, l.id, 'deferred_interest_released', auth.uid(), v_amount,
            jsonb_build_object('installment_no', r.installment_no,
                               'effective_on', GREATEST(r.due_date, d.disbursed_on),
                               'disbursement_id', d.id))
    RETURNING id INTO v_ev;

    PERFORM public.mf_post_event(v_ev);

    INSERT INTO public.mf_deferred_interest_releases
      (business_id, loan_id, installment_no, amount, released_on, account_id, loan_event_id)
    VALUES (l.business_id, l.id, r.installment_no, v_amount,
            GREATEST(r.due_date, d.disbursed_on), v_acc, v_ev);

    v_released := v_released + v_amount;
    v_sum := v_sum + v_amount;
    EXIT WHEN v_released >= v_total;
  END LOOP;

  RETURN v_sum;
END; $function$;

REVOKE ALL ON FUNCTION public.mf_release_deferred_interest(uuid, date, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mf_release_deferred_interest(uuid, date, boolean) TO authenticated, service_role;

-- 6. Institution-wide catch-up
CREATE OR REPLACE FUNCTION public.mf_release_deferred_interest_due(
  p_business_id uuid, p_as_of date DEFAULT CURRENT_DATE)
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
  LOOP
    v_sum := v_sum + public.mf_release_deferred_interest(r.id, p_as_of, false);
  END LOOP;
  RETURN v_sum;
END; $function$;

REVOKE ALL ON FUNCTION public.mf_release_deferred_interest_due(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mf_release_deferred_interest_due(uuid, date) TO authenticated, service_role;

-- 7. Closure / write-off earns whatever is left
CREATE OR REPLACE FUNCTION public._mf_release_deferred_on_loan_end()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IN ('closed','written_off') AND OLD.status <> NEW.status THEN
    PERFORM public.mf_release_deferred_interest(NEW.id, CURRENT_DATE, true);
  END IF;
  RETURN NEW;
END; $function$;

DROP TRIGGER IF EXISTS mf_loans_release_deferred_interest ON public.mf_loans;
CREATE TRIGGER mf_loans_release_deferred_interest
AFTER UPDATE OF status ON public.mf_loans
FOR EACH ROW EXECUTE FUNCTION public._mf_release_deferred_on_loan_end();

-- 8. A payout cannot be reversed once unearned interest has been earned
CREATE OR REPLACE FUNCTION public._mf_guard_disbursement_reversal_deferred()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.reversed_at IS NOT NULL AND OLD.reversed_at IS NULL
     AND EXISTS (SELECT 1 FROM public.mf_deferred_interest_releases
                  WHERE loan_id = NEW.loan_id) THEN
    RAISE EXCEPTION 'Interest already earned on this loan has been posted to income. Reverse those interest entries in the journal before reversing the payout.';
  END IF;
  RETURN NEW;
END; $function$;

DROP TRIGGER IF EXISTS mf_disbursement_guard_deferred ON public.mf_loan_disbursements;
CREATE TRIGGER mf_disbursement_guard_deferred
BEFORE UPDATE OF reversed_at ON public.mf_loan_disbursements
FOR EACH ROW EXECUTE FUNCTION public._mf_guard_disbursement_reversal_deferred();
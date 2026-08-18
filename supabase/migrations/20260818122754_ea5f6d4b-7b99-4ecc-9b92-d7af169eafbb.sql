-- Wave 2 Phase 10 + 11: one canonical bank matching seam
-- (proposal -> confirmation), n:m allocations, bank-fee residual,
-- canonical default-account resolution and canonical FX.

ALTER TABLE public.bank_reconciliation_matches
  ADD COLUMN IF NOT EXISTS allocations jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS fee_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fee_account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS exchange_rate numeric,
  ADD COLUMN IF NOT EXISTS rejected_by uuid,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS proposed_by uuid;

ALTER TABLE public.bank_reconciliation_matches
  DROP CONSTRAINT IF EXISTS bank_reconciliation_matches_status_check;
ALTER TABLE public.bank_reconciliation_matches
  ADD CONSTRAINT bank_reconciliation_matches_status_check
  CHECK (status = ANY (ARRAY['suggested','to_check','confirmed','rejected','reversed']));

CREATE INDEX IF NOT EXISTS bank_recon_matches_open_proposal_idx
  ON public.bank_reconciliation_matches (bank_transaction_id, status);

-- ---------------------------------------------------------------------------
-- Shared validation: an allocation set is a business fact about one bank line.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._bank_match_validate(
  _txn public.bank_transactions,
  _allocations jsonb,
  _fee_amount numeric
) RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
DECLARE
  _a jsonb;
  _kinds text[] := '{}';
  _sum numeric := 0;
  _open numeric;
  _biz uuid;
BEGIN
  IF _allocations IS NULL OR jsonb_typeof(_allocations) <> 'array' OR jsonb_array_length(_allocations) = 0 THEN
    RAISE EXCEPTION 'BANK_MATCH_NO_ALLOCATIONS' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(_fee_amount, 0) < 0 THEN
    RAISE EXCEPTION 'BANK_MATCH_NEGATIVE_FEE' USING ERRCODE = '22023';
  END IF;

  FOR _a IN SELECT jsonb_array_elements(_allocations) LOOP
    IF COALESCE((_a->>'amount')::numeric, 0) <= 0 THEN
      RAISE EXCEPTION 'BANK_MATCH_NONPOSITIVE_ALLOCATION' USING ERRCODE = '22023';
    END IF;
    _sum := _sum + (_a->>'amount')::numeric;
    _kinds := _kinds || COALESCE(_a->>'document_type', '');

    IF (_a->>'document_type') = 'invoice' THEN
      SELECT business_id, GREATEST(COALESCE(total,0) - COALESCE(amount_paid,0), 0)
        INTO _biz, _open
        FROM public.invoices WHERE id = (_a->>'document_id')::uuid;
      IF _biz IS NULL THEN RAISE EXCEPTION 'BANK_MATCH_DOCUMENT_NOT_FOUND' USING ERRCODE = '22023'; END IF;
    ELSIF (_a->>'document_type') = 'bill' THEN
      SELECT business_id, GREATEST(COALESCE(total,0) - COALESCE(amount_paid,0), 0)
        INTO _biz, _open
        FROM public.bills WHERE id = (_a->>'document_id')::uuid;
      IF _biz IS NULL THEN RAISE EXCEPTION 'BANK_MATCH_DOCUMENT_NOT_FOUND' USING ERRCODE = '22023'; END IF;
    ELSIF (_a->>'document_type') = 'account' THEN
      SELECT business_id, NULL::numeric INTO _biz, _open
        FROM public.accounts WHERE id = (_a->>'document_id')::uuid;
      IF _biz IS NULL THEN RAISE EXCEPTION 'BANK_MATCH_ACCOUNT_NOT_FOUND' USING ERRCODE = '22023'; END IF;
    ELSE
      RAISE EXCEPTION 'BANK_MATCH_UNSUPPORTED_DOCUMENT_TYPE' USING ERRCODE = '22023';
    END IF;

    IF _biz IS DISTINCT FROM _txn.business_id THEN
      RAISE EXCEPTION 'BANK_MATCH_CROSS_COMPANY' USING ERRCODE = '42501';
    END IF;
    IF _open IS NOT NULL AND (_a->>'amount')::numeric > _open + 0.005 THEN
      RAISE EXCEPTION 'BANK_MATCH_EXCEEDS_OPEN_AMOUNT' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  IF (SELECT count(DISTINCT k) FROM unnest(_kinds) k) > 1 THEN
    RAISE EXCEPTION 'BANK_MATCH_MIXED_DOCUMENT_TYPES' USING ERRCODE = '22023';
  END IF;

  IF abs(_sum + COALESCE(_fee_amount,0) - abs(_txn.amount)) > 0.005 THEN
    RAISE EXCEPTION 'BANK_MATCH_UNBALANCED: allocations + fee (%) must equal the bank line (%)',
      _sum + COALESCE(_fee_amount,0), abs(_txn.amount) USING ERRCODE = '22023';
  END IF;

  RETURN _kinds[1];
END;
$$;

-- ---------------------------------------------------------------------------
-- Propose
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bank_match_propose(
  _txn_id uuid,
  _allocations jsonb,
  _fee_amount numeric DEFAULT 0,
  _match_type text DEFAULT 'manual',
  _rule_id uuid DEFAULT NULL,
  _notes text DEFAULT NULL,
  _user_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _txn public.bank_transactions;
  _kind text;
  _match_id uuid;
BEGIN
  SELECT * INTO _txn FROM public.bank_transactions WHERE id = _txn_id FOR UPDATE;
  IF _txn.id IS NULL THEN
    RAISE EXCEPTION 'BANK_MATCH_TXN_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(_txn.is_reconciled, false) THEN
    RAISE EXCEPTION 'BANK_MATCH_ALREADY_RECONCILED' USING ERRCODE = '22023';
  END IF;

  PERFORM public.assert_can_reconcile_bank(_txn.business_id);

  IF _match_type NOT IN ('suggestion','manual','rule','auto','partial') THEN
    RAISE EXCEPTION 'BANK_MATCH_BAD_TYPE' USING ERRCODE = '22023';
  END IF;

  _kind := public._bank_match_validate(_txn, _allocations, _fee_amount);

  UPDATE public.bank_reconciliation_matches
     SET status = 'rejected', rejected_by = _user_id, rejected_at = now(), updated_at = now()
   WHERE bank_transaction_id = _txn_id
     AND status IN ('suggested','to_check');

  INSERT INTO public.bank_reconciliation_matches (
    organization_id, business_id, branch_id, bank_transaction_id,
    matched_entity_type, matched_entity_id, matched_amount, residual_amount,
    allocations, fee_amount, match_type, status, confidence, rule_id, notes,
    created_by, proposed_by
  ) VALUES (
    _txn.organization_id, _txn.business_id, _txn.branch_id, _txn_id,
    _kind, NULLIF(_allocations->0->>'document_id','')::uuid,
    abs(_txn.amount) - COALESCE(_fee_amount,0), COALESCE(_fee_amount,0),
    _allocations, COALESCE(_fee_amount,0), _match_type, 'suggested',
    CASE WHEN _match_type = 'manual' THEN 1 WHEN _match_type = 'rule' THEN 0.9 ELSE 0.8 END,
    _rule_id, _notes, _user_id, _user_id
  ) RETURNING id INTO _match_id;

  RETURN jsonb_build_object('success', true, 'match_id', _match_id, 'document_type', _kind);
END;
$$;

-- ---------------------------------------------------------------------------
-- Confirm: delegates settlement to the canonical AR/AP engines and the
-- canonical posting engine. Never writes payments or journal rows itself.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bank_match_confirm(
  _match_id uuid,
  _user_id uuid DEFAULT NULL,
  _client_request_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _m public.bank_reconciliation_matches;
  _txn public.bank_transactions;
  _kind text;
  _bank_gl uuid;
  _control uuid;
  _fee_account uuid;
  _party uuid;
  _parties uuid[];
  _alloc jsonb;
  _settlement jsonb;
  _payment_id uuid;
  _bill_payment_id uuid;
  _je_id uuid;
  _fee_je uuid;
  _rate numeric;
  _base text;
  _txn_currency text;
  _abs numeric;
  _net numeric;
  _req text;
  _receipt text;
  _a jsonb;
BEGIN
  SELECT * INTO _m FROM public.bank_reconciliation_matches WHERE id = _match_id FOR UPDATE;
  IF _m.id IS NULL THEN
    RAISE EXCEPTION 'BANK_MATCH_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF _m.status NOT IN ('suggested','to_check') THEN
    RAISE EXCEPTION 'BANK_MATCH_NOT_OPEN' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO _txn FROM public.bank_transactions WHERE id = _m.bank_transaction_id FOR UPDATE;
  IF COALESCE(_txn.is_reconciled, false) THEN
    RAISE EXCEPTION 'BANK_MATCH_ALREADY_RECONCILED' USING ERRCODE = '22023';
  END IF;

  PERFORM public.assert_can_reconcile_bank(_txn.business_id);

  IF NOT public.is_period_open(_txn.business_id, _txn.transaction_date) THEN
    RAISE EXCEPTION 'BANK_MATCH_PERIOD_LOCKED' USING ERRCODE = '22023';
  END IF;

  -- revalidate against live open amounts
  _kind := public._bank_match_validate(_txn, _m.allocations, _m.fee_amount);

  SELECT account_id INTO _bank_gl
    FROM public.bank_accounts
   WHERE id = _txn.bank_account_id
     AND business_id = _txn.business_id;
  IF _bank_gl IS NULL THEN
    RAISE EXCEPTION 'BANK_ACCOUNT_NEEDS_GL' USING ERRCODE = '22023';
  END IF;

  _abs := abs(_txn.amount);
  _net := _abs - COALESCE(_m.fee_amount, 0);
  _req := COALESCE(_client_request_id, 'bmatch:' || _match_id::text);

  -- Canonical FX: a foreign-currency bank line without a rate is a refusal.
  SELECT base_currency INTO _base FROM public.businesses WHERE id = _txn.business_id;
  _txn_currency := COALESCE(_txn.original_currency, _base);
  IF _txn_currency IS DISTINCT FROM _base THEN
    _rate := public.require_exchange_rate(_txn.organization_id, _txn.business_id, _txn_currency, _txn.transaction_date);
  ELSE
    _rate := 1;
  END IF;

  IF _kind = 'invoice' THEN
    _control := public._resolve_canonical_default_account('accounts_receivable', _txn.organization_id, _txn.business_id, _txn.branch_id);
    IF _control IS NULL THEN
      RAISE EXCEPTION 'BANK_MATCH_NO_AR_ACCOUNT' USING ERRCODE = '22023';
    END IF;

    SELECT array_agg(DISTINCT i.contact_id) INTO _parties
      FROM jsonb_array_elements(_m.allocations) a
      JOIN public.invoices i ON i.id = (a->>'document_id')::uuid;
    IF array_length(_parties, 1) <> 1 THEN
      RAISE EXCEPTION 'BANK_MATCH_MULTIPLE_CUSTOMERS' USING ERRCODE = '22023';
    END IF;
    _party := _parties[1];

    SELECT jsonb_agg(jsonb_build_object('invoice_id', a->>'document_id', 'amount', (a->>'amount')::numeric))
      INTO _alloc FROM jsonb_array_elements(_m.allocations) a;

    _receipt := COALESCE(public.get_next_receipt_number(_txn.organization_id, _txn.business_id, _txn.branch_id),
                         'RCP-BMATCH-' || substr(_match_id::text, 1, 8));

    _settlement := public.record_multi_invoice_payment(
      _org_id := _txn.organization_id,
      _business_id := _txn.business_id,
      _contact_id := _party,
      _allocations := _alloc,
      _total_amount := _net,
      _payment_date := _txn.transaction_date,
      _payment_method := 'bank_transfer',
      _reference := COALESCE(_txn.reference, 'Bank match: ' || COALESCE(_txn.description, '')),
      _notes := 'Created by bank reconciliation match',
      _receipt_number := _receipt,
      _created_by := _user_id,
      _deposit_account_id := _bank_gl,
      _receivable_account_id := _control,
      _customer_credit_account_id := NULL,
      _branch_id := _txn.branch_id,
      _exchange_rate := _rate,
      _request_id := _req
    );
    _payment_id := NULLIF(_settlement->>'payment_id','')::uuid;
    _je_id := NULLIF(_settlement->>'journal_entry_id','')::uuid;

  ELSIF _kind = 'bill' THEN
    _control := public._resolve_canonical_default_account('accounts_payable', _txn.organization_id, _txn.business_id, _txn.branch_id);
    IF _control IS NULL THEN
      RAISE EXCEPTION 'BANK_MATCH_NO_AP_ACCOUNT' USING ERRCODE = '22023';
    END IF;

    SELECT array_agg(DISTINCT b.vendor_id) INTO _parties
      FROM jsonb_array_elements(_m.allocations) a
      JOIN public.bills b ON b.id = (a->>'document_id')::uuid;
    IF array_length(_parties, 1) <> 1 THEN
      RAISE EXCEPTION 'BANK_MATCH_MULTIPLE_VENDORS' USING ERRCODE = '22023';
    END IF;
    _party := _parties[1];

    SELECT jsonb_agg(jsonb_build_object('bill_id', a->>'document_id', 'amount', (a->>'amount')::numeric))
      INTO _alloc FROM jsonb_array_elements(_m.allocations) a;

    _settlement := public.record_multi_bill_payment(
      _org_id := _txn.organization_id,
      _business_id := _txn.business_id,
      _vendor_id := _party,
      _allocations := _alloc,
      _total_amount := _net,
      _payment_date := _txn.transaction_date,
      _payment_method := 'bank_transfer',
      _reference := COALESCE(_txn.reference, 'Bank match: ' || COALESCE(_txn.description, '')),
      _notes := 'Created by bank reconciliation match',
      _created_by := _user_id,
      _bank_account_id := _txn.bank_account_id,
      _payable_account_id := _control,
      _branch_id := _txn.branch_id,
      _request_id := _req,
      _exchange_rate := _rate
    );
    _bill_payment_id := NULLIF(_settlement->>'bill_payment_id','')::uuid;
    _je_id := NULLIF(_settlement->>'journal_entry_id','')::uuid;

  ELSE -- 'account': a classified bank movement with no AR/AP document
    FOR _a IN SELECT jsonb_array_elements(_m.allocations) LOOP
      IF (SELECT COALESCE(branch_id, _txn.branch_id) FROM public.accounts WHERE id = (_a->>'document_id')::uuid)
         IS DISTINCT FROM COALESCE(_txn.branch_id, (SELECT branch_id FROM public.accounts WHERE id = (_a->>'document_id')::uuid))
      THEN
        RAISE EXCEPTION 'BANK_MATCH_CROSS_BRANCH_ACCOUNT' USING ERRCODE = '42501';
      END IF;
    END LOOP;

    _je_id := public.post_journal_entry_atomic(
      _txn.organization_id, _txn.business_id,
      public.generate_next_je_number(_txn.organization_id, _txn.business_id),
      _txn.transaction_date,
      'BMATCH-' || substr(_match_id::text, 1, 8),
      'Bank reconciliation: classified bank movement',
      'bank_reconciliation', _txn.id, _user_id, false, false,
      CASE WHEN _txn.transaction_type = 'credit' THEN
        jsonb_build_object('account_id', _bank_gl, 'debit', _net, 'credit', 0,
                           'description', COALESCE(_txn.description, 'Bank deposit'))
        || '{}'::jsonb
      ELSE
        jsonb_build_object('account_id', _bank_gl, 'debit', 0, 'credit', _net,
                           'description', COALESCE(_txn.description, 'Bank withdrawal'))
        || '{}'::jsonb
      END
      ||
      '{}'::jsonb,
      _txn_currency, _rate, NULL, _txn.branch_id
    );
  END IF;

  -- Bank fee residual: DR bank charges / CR bank, through the one engine.
  IF COALESCE(_m.fee_amount, 0) > 0 THEN
    _fee_account := COALESCE(
      _m.fee_account_id,
      public._resolve_canonical_default_account('bank_fees', _txn.organization_id, _txn.business_id, _txn.branch_id)
    );
    IF _fee_account IS NULL THEN
      RAISE EXCEPTION 'BANK_MATCH_NO_FEE_ACCOUNT' USING ERRCODE = '22023';
    END IF;

    _fee_je := public.post_journal_entry_atomic(
      _txn.organization_id, _txn.business_id,
      public.generate_next_je_number(_txn.organization_id, _txn.business_id),
      _txn.transaction_date,
      'BFEE-' || substr(_match_id::text, 1, 8),
      'Bank charge on reconciled bank line',
      'bank_recon', _match_id, _user_id, false, false,
      jsonb_build_array(
        jsonb_build_object('account_id', _fee_account, 'debit', _m.fee_amount, 'credit', 0,
                           'description', 'Bank charge'),
        jsonb_build_object('account_id', _bank_gl, 'debit', 0, 'credit', _m.fee_amount,
                           'description', 'Bank charge')
      ),
      _txn_currency, _rate, 'bank_charge', _txn.branch_id
    );
  END IF;

  UPDATE public.bank_transactions SET
    is_reconciled = true,
    reconciled_type = _kind,
    reconciled_entity_id = NULLIF(_m.allocations->0->>'document_id','')::uuid,
    reconciled_at = now(),
    reconciled_by = _user_id,
    journal_entry_id = _je_id,
    reconciled_payment_id = COALESCE(_payment_id, _bill_payment_id),
    lifecycle_status = 'reconciled',
    updated_at = now()
  WHERE id = _txn.id;

  UPDATE public.bank_reconciliation_matches SET
    status = 'confirmed',
    matched_journal_entry_id = _je_id,
    matched_payment_id = _payment_id,
    matched_bill_payment_id = _bill_payment_id,
    fee_account_id = _fee_account,
    exchange_rate = _rate,
    confidence = 1,
    confirmed_by = _user_id,
    confirmed_at = now(),
    updated_at = now()
  WHERE id = _match_id;

  RETURN jsonb_build_object(
    'success', true,
    'match_id', _match_id,
    'journal_entry_id', _je_id,
    'fee_journal_entry_id', _fee_je,
    'payment_id', _payment_id,
    'bill_payment_id', _bill_payment_id,
    'exchange_rate', _rate
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Reject / reverse
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bank_match_reject(
  _match_id uuid,
  _reason text DEFAULT NULL,
  _user_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _m public.bank_reconciliation_matches;
BEGIN
  SELECT * INTO _m FROM public.bank_reconciliation_matches WHERE id = _match_id FOR UPDATE;
  IF _m.id IS NULL THEN
    RAISE EXCEPTION 'BANK_MATCH_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  PERFORM public.assert_can_reconcile_bank(_m.business_id);
  IF _m.status NOT IN ('suggested','to_check') THEN
    RAISE EXCEPTION 'BANK_MATCH_NOT_OPEN' USING ERRCODE = '22023';
  END IF;

  UPDATE public.bank_reconciliation_matches
     SET status = 'rejected', rejected_by = _user_id, rejected_at = now(),
         notes = trim(both from concat_ws(' | ', notes, 'Rejected: ' || COALESCE(_reason, 'no reason given'))),
         updated_at = now()
   WHERE id = _match_id;

  RETURN jsonb_build_object('success', true, 'match_id', _match_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.bank_match_reverse(
  _match_id uuid,
  _reason text DEFAULT NULL,
  _user_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _m public.bank_reconciliation_matches;
  _res jsonb;
BEGIN
  SELECT * INTO _m FROM public.bank_reconciliation_matches WHERE id = _match_id FOR UPDATE;
  IF _m.id IS NULL THEN
    RAISE EXCEPTION 'BANK_MATCH_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  PERFORM public.assert_can_reconcile_bank(_m.business_id);
  IF _m.status <> 'confirmed' THEN
    RAISE EXCEPTION 'BANK_MATCH_NOT_CONFIRMED' USING ERRCODE = '22023';
  END IF;

  _res := public.unreconcile_bank_transaction(
    _m.bank_transaction_id,
    COALESCE(_reason, 'Bank match reversed'),
    _user_id
  );

  RETURN jsonb_build_object('success', true, 'match_id', _match_id, 'reversal', _res);
END;
$$;

REVOKE ALL ON FUNCTION public._bank_match_validate(public.bank_transactions, jsonb, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bank_match_propose(uuid, jsonb, numeric, text, uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bank_match_confirm(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bank_match_reject(uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bank_match_reverse(uuid, text, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.bank_match_propose(uuid, jsonb, numeric, text, uuid, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bank_match_confirm(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bank_match_reject(uuid, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bank_match_reverse(uuid, text, uuid) TO authenticated, service_role;
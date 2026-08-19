-- ============================================================
-- Reconciliation engine: core accounting corrections
-- ============================================================

ALTER TABLE public.bank_reconciliation_matches
  ADD COLUMN IF NOT EXISTS fee_journal_entry_id uuid,
  ADD COLUMN IF NOT EXISTS adjustment_journal_entry_id uuid,
  ADD COLUMN IF NOT EXISTS evidence jsonb;

-- At most one confirmed match per bank line.
CREATE UNIQUE INDEX IF NOT EXISTS bank_reconciliation_matches_one_confirmed
  ON public.bank_reconciliation_matches (bank_transaction_id)
  WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS bank_reconciliation_matches_allocations_gin
  ON public.bank_reconciliation_matches USING gin (allocations jsonb_path_ops);

REVOKE EXECUTE ON FUNCTION public.get_reconciliation_match_suggestions(uuid, uuid, uuid, integer) FROM anon;

-- ------------------------------------------------------------
-- Validator: resolution vocabulary, isolation, direction, amount law
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._bank_match_validate(_txn bank_transactions, _allocations jsonb, _fee_amount numeric)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  _a jsonb;
  _kind text;
  _kinds text[] := '{}';
  _primaries text[];
  _primary text;
  _sum numeric := 0;
  _open numeric;
  _biz uuid;
  _branch uuid;
  _ccy text;
  _amt numeric;
  _inflow boolean;
  _bank_ccy text;
  _bank_gl uuid;
  _dep uuid;
  _status text;
  _pay_amount numeric;
  _required numeric;
  _dest_ccy text;
BEGIN
  IF _allocations IS NULL OR jsonb_typeof(_allocations) <> 'array' OR jsonb_array_length(_allocations) = 0 THEN
    RAISE EXCEPTION 'BANK_MATCH_NO_ALLOCATIONS' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(_fee_amount, 0) < 0 THEN
    RAISE EXCEPTION 'BANK_MATCH_NEGATIVE_FEE' USING ERRCODE = '22023';
  END IF;

  _inflow := COALESCE(_txn.transaction_type, CASE WHEN _txn.amount >= 0 THEN 'credit' ELSE 'debit' END) = 'credit';

  SELECT currency, account_id INTO _bank_ccy, _bank_gl
    FROM public.bank_accounts WHERE id = _txn.bank_account_id;

  FOR _a IN SELECT jsonb_array_elements(_allocations) LOOP
    _kind := COALESCE(_a->>'document_type', '');
    _amt := COALESCE((_a->>'amount')::numeric, 0);
    IF _amt <= 0 THEN
      RAISE EXCEPTION 'BANK_MATCH_NONPOSITIVE_ALLOCATION' USING ERRCODE = '22023';
    END IF;
    _sum := _sum + _amt;
    _kinds := _kinds || _kind;
    _biz := NULL; _branch := NULL; _ccy := NULL; _open := NULL;

    IF _kind = 'invoice' THEN
      IF NOT _inflow THEN
        RAISE EXCEPTION 'BANK_MATCH_DIRECTION_MISMATCH: an invoice is settled by money in' USING ERRCODE = '22023';
      END IF;
      SELECT business_id, branch_id, currency, GREATEST(COALESCE(total,0) - COALESCE(amount_paid,0), 0)
        INTO _biz, _branch, _ccy, _open
        FROM public.invoices WHERE id = (_a->>'document_id')::uuid;
      IF _biz IS NULL THEN RAISE EXCEPTION 'BANK_MATCH_DOCUMENT_NOT_FOUND' USING ERRCODE = '22023'; END IF;

    ELSIF _kind = 'bill' THEN
      IF _inflow THEN
        RAISE EXCEPTION 'BANK_MATCH_DIRECTION_MISMATCH: a bill is settled by money out' USING ERRCODE = '22023';
      END IF;
      SELECT business_id, branch_id, currency, GREATEST(COALESCE(total,0) - COALESCE(amount_paid,0), 0)
        INTO _biz, _branch, _ccy, _open
        FROM public.bills WHERE id = (_a->>'document_id')::uuid;
      IF _biz IS NULL THEN RAISE EXCEPTION 'BANK_MATCH_DOCUMENT_NOT_FOUND' USING ERRCODE = '22023'; END IF;

    ELSIF _kind = 'payment' THEN
      -- A receipt that already exists. This bank line is its deposit.
      IF NOT _inflow THEN
        RAISE EXCEPTION 'BANK_MATCH_DIRECTION_MISMATCH: a customer receipt is deposited by money in' USING ERRCODE = '22023';
      END IF;
      SELECT business_id, branch_id, deposit_account_id, status, amount
        INTO _biz, _branch, _dep, _status, _pay_amount
        FROM public.payments WHERE id = (_a->>'document_id')::uuid;
      IF _biz IS NULL THEN RAISE EXCEPTION 'BANK_MATCH_PAYMENT_NOT_FOUND' USING ERRCODE = '22023'; END IF;
      IF COALESCE(_status, '') IN ('voided', 'cancelled') THEN
        RAISE EXCEPTION 'BANK_MATCH_PAYMENT_VOIDED' USING ERRCODE = '22023';
      END IF;
      IF _dep IS NULL THEN
        RAISE EXCEPTION 'BANK_MATCH_PAYMENT_NO_DEPOSIT_ACCOUNT' USING ERRCODE = '22023';
      END IF;
      IF abs(_amt - COALESCE(_pay_amount, 0)) > 0.005 THEN
        RAISE EXCEPTION 'BANK_MATCH_PAYMENT_AMOUNT_MISMATCH: a receipt is deposited in full' USING ERRCODE = '22023';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.bank_reconciliation_matches m
         WHERE m.status = 'confirmed'
           AND m.bank_transaction_id IS DISTINCT FROM _txn.id
           AND m.allocations @> jsonb_build_array(jsonb_build_object('document_type','payment','document_id', _a->>'document_id'))
      ) THEN
        RAISE EXCEPTION 'BANK_MATCH_PAYMENT_ALREADY_DEPOSITED' USING ERRCODE = '22023';
      END IF;

    ELSIF _kind = 'bill_payment' THEN
      IF _inflow THEN
        RAISE EXCEPTION 'BANK_MATCH_DIRECTION_MISMATCH: a supplier payment clears by money out' USING ERRCODE = '22023';
      END IF;
      SELECT business_id, branch_id, status, amount
        INTO _biz, _branch, _status, _pay_amount
        FROM public.bill_payments WHERE id = (_a->>'document_id')::uuid;
      IF _biz IS NULL THEN RAISE EXCEPTION 'BANK_MATCH_PAYMENT_NOT_FOUND' USING ERRCODE = '22023'; END IF;
      IF COALESCE(_status, '') IN ('voided', 'cancelled') THEN
        RAISE EXCEPTION 'BANK_MATCH_PAYMENT_VOIDED' USING ERRCODE = '22023';
      END IF;
      IF abs(_amt - COALESCE(_pay_amount, 0)) > 0.005 THEN
        RAISE EXCEPTION 'BANK_MATCH_PAYMENT_AMOUNT_MISMATCH: a supplier payment clears in full' USING ERRCODE = '22023';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.bank_reconciliation_matches m
         WHERE m.status = 'confirmed'
           AND m.bank_transaction_id IS DISTINCT FROM _txn.id
           AND m.allocations @> jsonb_build_array(jsonb_build_object('document_type','bill_payment','document_id', _a->>'document_id'))
      ) THEN
        RAISE EXCEPTION 'BANK_MATCH_PAYMENT_ALREADY_DEPOSITED' USING ERRCODE = '22023';
      END IF;

    ELSIF _kind = 'transfer' THEN
      IF jsonb_array_length(_allocations) <> 1 THEN
        RAISE EXCEPTION 'BANK_MATCH_TRANSFER_SINGLE_ALLOCATION' USING ERRCODE = '22023';
      END IF;
      SELECT business_id, branch_id, currency INTO _biz, _branch, _dest_ccy
        FROM public.bank_accounts WHERE id = (_a->>'document_id')::uuid;
      IF _biz IS NULL THEN RAISE EXCEPTION 'BANK_MATCH_TRANSFER_ACCOUNT_NOT_FOUND' USING ERRCODE = '22023'; END IF;
      IF (_a->>'document_id')::uuid = _txn.bank_account_id THEN
        RAISE EXCEPTION 'BANK_MATCH_TRANSFER_SAME_ACCOUNT' USING ERRCODE = '22023';
      END IF;
      _ccy := _dest_ccy;
      _branch := NULL; -- a transfer counterparty account may live in another branch

    ELSIF _kind = 'account' THEN
      SELECT business_id INTO _biz FROM public.accounts WHERE id = (_a->>'document_id')::uuid;
      IF _biz IS NULL THEN RAISE EXCEPTION 'BANK_MATCH_ACCOUNT_NOT_FOUND' USING ERRCODE = '22023'; END IF;

    ELSE
      RAISE EXCEPTION 'BANK_MATCH_UNSUPPORTED_DOCUMENT_TYPE' USING ERRCODE = '22023';
    END IF;

    IF _biz IS DISTINCT FROM _txn.business_id THEN
      RAISE EXCEPTION 'BANK_MATCH_CROSS_COMPANY' USING ERRCODE = '42501';
    END IF;
    IF _branch IS NOT NULL AND _txn.branch_id IS NOT NULL AND _branch IS DISTINCT FROM _txn.branch_id THEN
      RAISE EXCEPTION 'BANK_MATCH_CROSS_BRANCH' USING ERRCODE = '42501';
    END IF;
    IF _ccy IS NOT NULL AND _bank_ccy IS NOT NULL AND _ccy IS DISTINCT FROM _bank_ccy THEN
      RAISE EXCEPTION 'BANK_MATCH_CURRENCY_MISMATCH: % against a % bank account', _ccy, _bank_ccy USING ERRCODE = '22023';
    END IF;
    IF _open IS NOT NULL AND _amt > _open + 0.005 THEN
      RAISE EXCEPTION 'BANK_MATCH_EXCEEDS_OPEN_AMOUNT' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  SELECT array_agg(DISTINCT k) INTO _primaries FROM unnest(_kinds) k WHERE k <> 'account';
  IF _primaries IS NULL THEN
    _primary := 'account';
  ELSIF array_length(_primaries, 1) > 1 THEN
    RAISE EXCEPTION 'BANK_MATCH_MIXED_DOCUMENT_TYPES' USING ERRCODE = '22023';
  ELSE
    _primary := _primaries[1];
  END IF;

  -- Amount law: the documents are settled GROSS; the bank moves the statement
  -- amount. On money in the bank received less than was settled by the charge;
  -- on money out it paid more.
  _required := abs(_txn.amount) + CASE WHEN _inflow THEN COALESCE(_fee_amount, 0) ELSE -COALESCE(_fee_amount, 0) END;
  IF abs(_sum - _required) > 0.005 THEN
    RAISE EXCEPTION 'BANK_MATCH_UNBALANCED: allocations (%) must equal the bank line (%) adjusted for the bank charge (%)',
      _sum, abs(_txn.amount), COALESCE(_fee_amount, 0) USING ERRCODE = '22023';
  END IF;

  RETURN _primary;
END;
$function$;

-- ------------------------------------------------------------
-- Confirm: orchestrate authoritative engines, never mint duplicates
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bank_match_confirm(_match_id uuid, _user_id uuid DEFAULT NULL::uuid, _client_request_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  _lines jsonb;
  _clearing_lines jsonb := '[]'::jsonb;
  _residual_lines jsonb := '[]'::jsonb;
  _settlement jsonb;
  _payment_id uuid;
  _bill_payment_id uuid;
  _je_id uuid;
  _fee_je uuid;
  _adj_je uuid;
  _rate numeric;
  _base text;
  _txn_currency text;
  _abs numeric;
  _gross numeric;
  _resid numeric;
  _clearing numeric := 0;
  _req text;
  _receipt text;
  _inflow boolean;
  _a jsonb;
  _dep uuid;
  _mirror uuid;
  _dest_gl uuid;
BEGIN
  SELECT * INTO _m FROM public.bank_reconciliation_matches WHERE id = _match_id FOR UPDATE;
  IF _m.id IS NULL THEN
    RAISE EXCEPTION 'BANK_MATCH_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF _m.status = 'confirmed' THEN
    -- Idempotent: a retry observes the settlement it already produced.
    RETURN jsonb_build_object('success', true, 'match_id', _match_id, 'already_confirmed', true,
      'journal_entry_id', _m.matched_journal_entry_id, 'payment_id', _m.matched_payment_id,
      'bill_payment_id', _m.matched_bill_payment_id);
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

  _kind := public._bank_match_validate(_txn, _m.allocations, _m.fee_amount);

  SELECT account_id INTO _bank_gl
    FROM public.bank_accounts
   WHERE id = _txn.bank_account_id
     AND business_id = _txn.business_id;
  IF _bank_gl IS NULL THEN
    RAISE EXCEPTION 'BANK_ACCOUNT_NEEDS_GL' USING ERRCODE = '22023';
  END IF;

  _abs := abs(_txn.amount);
  _req := COALESCE(_client_request_id, 'bmatch:' || _match_id::text);
  _inflow := COALESCE(_txn.transaction_type, CASE WHEN _txn.amount >= 0 THEN 'credit' ELSE 'debit' END) = 'credit';

  SELECT COALESCE(sum((a->>'amount')::numeric), 0) INTO _gross
    FROM jsonb_array_elements(_m.allocations) a
   WHERE COALESCE(a->>'document_type','') = _kind;
  SELECT COALESCE(sum((a->>'amount')::numeric), 0) INTO _resid
    FROM jsonb_array_elements(_m.allocations) a
   WHERE _kind <> 'account' AND COALESCE(a->>'document_type','') = 'account';

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
      JOIN public.invoices i ON i.id = (a->>'document_id')::uuid
     WHERE a->>'document_type' = 'invoice';
    IF array_length(_parties, 1) <> 1 THEN
      RAISE EXCEPTION 'BANK_MATCH_MULTIPLE_CUSTOMERS' USING ERRCODE = '22023';
    END IF;
    _party := _parties[1];

    SELECT jsonb_agg(jsonb_build_object('invoice_id', a->>'document_id', 'amount', (a->>'amount')::numeric))
      INTO _alloc FROM jsonb_array_elements(_m.allocations) a WHERE a->>'document_type' = 'invoice';

    _receipt := COALESCE(public.get_next_receipt_number(_txn.organization_id, _txn.business_id, _txn.branch_id),
                         'RCP-BMATCH-' || substr(_match_id::text, 1, 8));

    _settlement := public.record_multi_invoice_payment(
      _org_id := _txn.organization_id,
      _business_id := _txn.business_id,
      _contact_id := _party,
      _allocations := _alloc,
      _total_amount := _gross,
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
      JOIN public.bills b ON b.id = (a->>'document_id')::uuid
     WHERE a->>'document_type' = 'bill';
    IF array_length(_parties, 1) <> 1 THEN
      RAISE EXCEPTION 'BANK_MATCH_MULTIPLE_VENDORS' USING ERRCODE = '22023';
    END IF;
    _party := _parties[1];

    SELECT jsonb_agg(jsonb_build_object('bill_id', a->>'document_id', 'amount', (a->>'amount')::numeric))
      INTO _alloc FROM jsonb_array_elements(_m.allocations) a WHERE a->>'document_type' = 'bill';

    _settlement := public.record_multi_bill_payment(
      _org_id := _txn.organization_id,
      _business_id := _txn.business_id,
      _vendor_id := _party,
      _allocations := _alloc,
      _total_amount := _gross,
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

  ELSIF _kind IN ('payment','bill_payment') THEN
    -- The economic event already happened and is already posted. This line is
    -- its arrival at the bank: clear the holding account, never re-settle.
    FOR _a IN SELECT jsonb_array_elements(_m.allocations) WHERE true LOOP
      CONTINUE WHEN COALESCE(_a->>'document_type','') <> _kind;
      IF _kind = 'payment' THEN
        SELECT p.deposit_account_id INTO _dep FROM public.payments p WHERE p.id = (_a->>'document_id')::uuid;
        IF _payment_id IS NULL THEN _payment_id := (_a->>'document_id')::uuid; END IF;
      ELSE
        SELECT ba.account_id INTO _dep
          FROM public.bill_payments bp
          LEFT JOIN public.bank_accounts ba ON ba.id = bp.bank_account_id
         WHERE bp.id = (_a->>'document_id')::uuid;
        IF _bill_payment_id IS NULL THEN _bill_payment_id := (_a->>'document_id')::uuid; END IF;
      END IF;

      IF _dep IS NULL THEN
        RAISE EXCEPTION 'BANK_MATCH_PAYMENT_NO_HOLDING_ACCOUNT' USING ERRCODE = '22023';
      END IF;

      IF _dep = _bank_gl THEN
        -- Already posted straight to this bank account: linkage only, no posting.
        CONTINUE;
      END IF;

      IF EXISTS (SELECT 1 FROM public.bank_accounts ba WHERE ba.account_id = _dep AND ba.business_id = _txn.business_id) THEN
        RAISE EXCEPTION 'BANK_MATCH_PAYMENT_OTHER_BANK_ACCOUNT: this payment settled another bank account — record a transfer instead'
          USING ERRCODE = '22023';
      END IF;

      _clearing := _clearing + (_a->>'amount')::numeric;
      _clearing_lines := _clearing_lines || jsonb_build_object(
        'account_id', _dep,
        'debit',  CASE WHEN _inflow THEN 0 ELSE (_a->>'amount')::numeric END,
        'credit', CASE WHEN _inflow THEN (_a->>'amount')::numeric ELSE 0 END,
        'description', COALESCE(_txn.description, 'Cleared to bank')
      );
    END LOOP;

    IF _clearing > 0 THEN
      _lines := jsonb_build_array(jsonb_build_object(
        'account_id', _bank_gl,
        'debit',  CASE WHEN _inflow THEN _clearing ELSE 0 END,
        'credit', CASE WHEN _inflow THEN 0 ELSE _clearing END,
        'description', COALESCE(_txn.description, 'Bank deposit')
      )) || _clearing_lines;

      _je_id := public.post_journal_entry_atomic(
        _txn.organization_id, _txn.business_id,
        public.generate_next_je_number(_txn.organization_id, _txn.business_id),
        _txn.transaction_date,
        'BDEP-' || substr(_match_id::text, 1, 8),
        CASE WHEN _kind = 'payment' THEN 'Deposit of recorded receipts into bank'
             ELSE 'Clearing of recorded supplier payments through bank' END,
        'bank_reconciliation', _txn.id, _user_id, false, false,
        _lines,
        _txn_currency, _rate, 'clearing', _txn.branch_id
      );
    END IF;

  ELSIF _kind = 'transfer' THEN
    SELECT ba.account_id INTO _dest_gl
      FROM public.bank_accounts ba
     WHERE ba.id = (_m.allocations->0->>'document_id')::uuid;
    IF _dest_gl IS NULL THEN
      RAISE EXCEPTION 'BANK_ACCOUNT_NEEDS_GL' USING ERRCODE = '22023';
    END IF;

    _je_id := public.post_journal_entry_atomic(
      _txn.organization_id, _txn.business_id,
      public.generate_next_je_number(_txn.organization_id, _txn.business_id),
      _txn.transaction_date,
      'BXFER-' || substr(_match_id::text, 1, 8),
      'Bank transfer',
      'bank_reconciliation', _txn.id, _user_id, false, false,
      jsonb_build_array(
        jsonb_build_object('account_id', CASE WHEN _inflow THEN _bank_gl ELSE _dest_gl END,
                           'debit', _gross, 'credit', 0, 'description', COALESCE(_txn.description, 'Bank transfer')),
        jsonb_build_object('account_id', CASE WHEN _inflow THEN _dest_gl ELSE _bank_gl END,
                           'debit', 0, 'credit', _gross, 'description', COALESCE(_txn.description, 'Bank transfer'))
      ),
      _txn_currency, _rate, 'transfer', _txn.branch_id
    );

    _mirror := NULLIF(_m.allocations->0->>'mirror_transaction_id','')::uuid;
    IF _mirror IS NOT NULL THEN
      UPDATE public.bank_transactions
         SET is_reconciled = true, reconciled_type = 'transfer',
             reconciled_entity_id = _txn.bank_account_id,
             reconciled_at = now(), reconciled_by = _user_id,
             journal_entry_id = _je_id, lifecycle_status = 'reconciled', updated_at = now()
       WHERE id = _mirror
         AND business_id = _txn.business_id
         AND COALESCE(is_reconciled, false) = false;
    END IF;

  ELSE
    -- Classified bank movement: no document, one or more offset accounts.
    SELECT jsonb_build_array(
             jsonb_build_object(
               'account_id', _bank_gl,
               'debit',  CASE WHEN _inflow THEN _gross ELSE 0 END,
               'credit', CASE WHEN _inflow THEN 0 ELSE _gross END,
               'description', COALESCE(_txn.description, 'Bank movement')
             )
           ) || COALESCE(jsonb_agg(
             jsonb_build_object(
               'account_id', (a->>'document_id')::uuid,
               'debit',  CASE WHEN _inflow THEN 0 ELSE (a->>'amount')::numeric END,
               'credit', CASE WHEN _inflow THEN (a->>'amount')::numeric ELSE 0 END,
               'description', COALESCE(a->>'description', _txn.description, 'Bank movement')
             )
           ), '[]'::jsonb)
      INTO _lines
      FROM jsonb_array_elements(_m.allocations) a;

    _je_id := public.post_journal_entry_atomic(
      _txn.organization_id, _txn.business_id,
      public.generate_next_je_number(_txn.organization_id, _txn.business_id),
      _txn.transaction_date,
      'BMATCH-' || substr(_match_id::text, 1, 8),
      'Bank reconciliation: classified bank movement',
      'bank_reconciliation', _txn.id, _user_id, false, false,
      _lines,
      _txn_currency, _rate, NULL, _txn.branch_id
    );
  END IF;

  -- Named residual: part of the line is not the document (interest, charge,
  -- other income). Posted as its own balanced entry against the bank.
  IF _kind <> 'account' AND _resid > 0 THEN
    SELECT jsonb_agg(
             jsonb_build_object(
               'account_id', (a->>'document_id')::uuid,
               'debit',  CASE WHEN _inflow THEN 0 ELSE (a->>'amount')::numeric END,
               'credit', CASE WHEN _inflow THEN (a->>'amount')::numeric ELSE 0 END,
               'description', COALESCE(a->>'description', _txn.description, 'Bank movement')
             )
           ) INTO _residual_lines
      FROM jsonb_array_elements(_m.allocations) a
     WHERE a->>'document_type' = 'account';

    _adj_je := public.post_journal_entry_atomic(
      _txn.organization_id, _txn.business_id,
      public.generate_next_je_number(_txn.organization_id, _txn.business_id),
      _txn.transaction_date,
      'BADJ-' || substr(_match_id::text, 1, 8),
      'Bank reconciliation: named residual on a matched bank line',
      'bank_recon_adjustment', _match_id, _user_id, false, false,
      jsonb_build_array(jsonb_build_object(
        'account_id', _bank_gl,
        'debit',  CASE WHEN _inflow THEN _resid ELSE 0 END,
        'credit', CASE WHEN _inflow THEN 0 ELSE _resid END,
        'description', COALESCE(_txn.description, 'Bank movement')
      )) || _residual_lines,
      _txn_currency, _rate, 'residual', _txn.branch_id
    );
  END IF;

  -- Bank charge: the difference between what was settled and what the bank
  -- moved. Recognised as an expense; the bank leg nets to the statement line.
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
        jsonb_build_object('account_id', _fee_account, 'debit', _m.fee_amount, 'credit', 0, 'description', 'Bank charge'),
        jsonb_build_object('account_id', _bank_gl, 'debit', 0, 'credit', _m.fee_amount, 'description', 'Bank charge')
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
    adjustment_journal_entry_id = _adj_je,
    fee_journal_entry_id = _fee_je,
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
    'resolution', _kind,
    'journal_entry_id', _je_id,
    'adjustment_journal_entry_id', _adj_je,
    'fee_journal_entry_id', _fee_je,
    'payment_id', _payment_id,
    'bill_payment_id', _bill_payment_id,
    'exchange_rate', _rate
  );
END;
$function$;

-- ------------------------------------------------------------
-- Reverse: delegate to the authoritative reversal engines
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.unreconcile_bank_transaction(_bank_transaction_id uuid, _reason text DEFAULT NULL::text, _user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _txn record;
  _m public.bank_reconciliation_matches;
  _writeoff record;
  _reversed_matches integer := 0;
  _reversed_writeoffs integer := 0;
  _voided_entries integer := 0;
  _kind text;
  _rdate date;
BEGIN
  SELECT * INTO _txn FROM public.bank_transactions WHERE id = _bank_transaction_id FOR UPDATE;
  IF _txn.id IS NULL THEN
    RAISE EXCEPTION 'Bank transaction % not found', _bank_transaction_id;
  END IF;

  PERFORM public.assert_can_reconcile_bank(_txn.business_id);

  IF NOT COALESCE(_txn.is_reconciled, false) THEN
    RETURN jsonb_build_object('success', true, 'already_unreconciled', true);
  END IF;

  _rdate := COALESCE(_txn.transaction_date, CURRENT_DATE);
  IF NOT public.is_period_open(_txn.business_id, _rdate) THEN
    RAISE EXCEPTION 'BANK_UNRECONCILE_PERIOD_LOCKED' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO _m
    FROM public.bank_reconciliation_matches
   WHERE bank_transaction_id = _bank_transaction_id
     AND status = 'confirmed'
   ORDER BY confirmed_at DESC NULLS LAST
   LIMIT 1
   FOR UPDATE;

  _kind := COALESCE(_m.matched_entity_type, _txn.reconciled_type);

  -- 1. Settlements the seam created are reversed by their own writer, so the
  --    document balance is recomputed from live allocations.
  IF _kind = 'invoice' AND _m.matched_payment_id IS NOT NULL THEN
    PERFORM public.void_payment_atomic(
      _payment_id := _m.matched_payment_id,
      _reason := COALESCE(_reason, 'Bank transaction unreconciled'),
      _reason_code := NULL,
      _void_date := _rdate,
      _actor := _user_id,
      _client_request_id := 'bunrec:' || _bank_transaction_id::text
    );
    _voided_entries := _voided_entries + 1;

  ELSIF _kind = 'bill' AND _m.matched_bill_payment_id IS NOT NULL THEN
    PERFORM public.void_bill_payment_atomic(
      _bill_payment_id := _m.matched_bill_payment_id,
      _reason := COALESCE(_reason, 'Bank transaction unreconciled'),
      _void_date := _rdate,
      _actor := _user_id,
      _client_request_id := 'bunrec:' || _bank_transaction_id::text,
      _reason_code := NULL
    );
    _voided_entries := _voided_entries + 1;

  ELSIF _txn.journal_entry_id IS NOT NULL THEN
    -- Clearing, transfer or classified movement: the reconciliation itself was
    -- the only posting, so voiding it is the whole reversal. The underlying
    -- payment stays valid — it simply is not deposited any more.
    PERFORM public.void_journal_entry_atomic(
      _txn.journal_entry_id,
      COALESCE(_reason, 'Bank transaction unreconciled'),
      _user_id,
      NULL,
      _rdate
    );
    _voided_entries := _voided_entries + 1;
  END IF;

  -- 2. Residual and bank-charge entries.
  IF _m.adjustment_journal_entry_id IS NOT NULL THEN
    PERFORM public.void_journal_entry_atomic(_m.adjustment_journal_entry_id,
      COALESCE(_reason, 'Bank transaction unreconciled'), _user_id, NULL, _rdate);
    _voided_entries := _voided_entries + 1;
  END IF;
  IF _m.fee_journal_entry_id IS NOT NULL THEN
    PERFORM public.void_journal_entry_atomic(_m.fee_journal_entry_id,
      COALESCE(_reason, 'Bank transaction unreconciled'), _user_id, NULL, _rdate);
    _voided_entries := _voided_entries + 1;
  END IF;

  -- 3. Write-offs raised on this line.
  FOR _writeoff IN
    SELECT w.*
    FROM public.bank_reconciliation_writeoffs w
    JOIN public.bank_reconciliation_matches m ON m.id = w.reconciliation_match_id
    WHERE m.bank_transaction_id = _bank_transaction_id
      AND w.status IN ('draft','posted')
  LOOP
    IF _writeoff.journal_entry_id IS NOT NULL THEN
      PERFORM public.void_journal_entry_atomic(
        _writeoff.journal_entry_id,
        COALESCE(_reason, 'Bank reconciliation write-off unreconciled'),
        _user_id,
        NULL,
        _rdate
      );
      _voided_entries := _voided_entries + 1;
    END IF;
  END LOOP;

  UPDATE public.bank_reconciliation_writeoffs w
     SET status = 'reversed', reversed_by = _user_id, reversed_at = now(), updated_at = now()
    FROM public.bank_reconciliation_matches m
   WHERE w.reconciliation_match_id = m.id
     AND m.bank_transaction_id = _bank_transaction_id
     AND w.status IN ('draft','posted');
  GET DIAGNOSTICS _reversed_writeoffs = ROW_COUNT;

  UPDATE public.bank_reconciliation_matches
     SET status = 'reversed',
         reversed_by = _user_id,
         reversed_at = now(),
         notes = trim(both from concat_ws(' | ', notes, 'Unreconciled: ' || COALESCE(_reason, 'No reason provided'))),
         updated_at = now()
   WHERE bank_transaction_id = _bank_transaction_id
     AND status IN ('suggested','to_check','confirmed');
  GET DIAGNOSTICS _reversed_matches = ROW_COUNT;

  -- 4. A transfer's mirror line is released with its source.
  IF _kind = 'transfer' AND _txn.journal_entry_id IS NOT NULL THEN
    UPDATE public.bank_transactions
       SET is_reconciled = false, reconciled_type = NULL, reconciled_entity_id = NULL,
           reconciled_at = NULL, reconciled_by = NULL, journal_entry_id = NULL,
           lifecycle_status = 'for_review', match_source = 'unreconciled', updated_at = now()
     WHERE journal_entry_id = _txn.journal_entry_id
       AND id <> _bank_transaction_id
       AND business_id = _txn.business_id;
  END IF;

  UPDATE public.bank_transactions
     SET is_reconciled = false,
         reconciled_type = NULL,
         reconciled_entity_id = NULL,
         reconciled_at = NULL,
         reconciled_by = NULL,
         journal_entry_id = NULL,
         reconciled_payment_id = NULL,
         match_confidence = NULL,
         match_source = 'unreconciled',
         lifecycle_status = 'for_review',
         updated_at = now()
   WHERE id = _bank_transaction_id;

  RETURN jsonb_build_object(
    'success', true,
    'resolution', _kind,
    'reversed_matches', _reversed_matches,
    'reversed_writeoffs', _reversed_writeoffs,
    'voided_entries', _voided_entries
  );
END;
$function$;

-- ------------------------------------------------------------
-- Transfers go through the seam like every other resolution
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reconcile_bank_transfer_atomic(_source_txn_id uuid, _dest_txn_id uuid DEFAULT NULL::uuid, _dest_bank_account_id uuid DEFAULT NULL::uuid, _user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _txn public.bank_transactions;
  _dest uuid;
  _proposed jsonb;
  _confirmed jsonb;
BEGIN
  SELECT * INTO _txn FROM public.bank_transactions WHERE id = _source_txn_id;
  IF _txn.id IS NULL THEN
    RAISE EXCEPTION 'BANK_MATCH_TXN_NOT_FOUND' USING ERRCODE = '22023';
  END IF;

  _dest := _dest_bank_account_id;
  IF _dest IS NULL AND _dest_txn_id IS NOT NULL THEN
    SELECT bank_account_id INTO _dest FROM public.bank_transactions WHERE id = _dest_txn_id;
  END IF;
  IF _dest IS NULL THEN
    RAISE EXCEPTION 'BANK_TRANSFER_DESTINATION_REQUIRED' USING ERRCODE = '22023';
  END IF;

  _proposed := public.bank_match_propose(
    _txn_id := _source_txn_id,
    _allocations := jsonb_build_array(jsonb_build_object(
      'document_type', 'transfer',
      'document_id', _dest,
      'amount', abs(_txn.amount),
      'mirror_transaction_id', _dest_txn_id,
      'description', COALESCE(_txn.description, 'Bank transfer')
    )),
    _fee_amount := 0,
    _match_type := 'manual',
    _rule_id := NULL,
    _notes := 'Bank transfer',
    _user_id := _user_id
  );

  _confirmed := public.bank_match_confirm(
    (_proposed->>'match_id')::uuid,
    _user_id,
    'bxfer:' || _source_txn_id::text
  );

  RETURN _confirmed;
END;
$function$;
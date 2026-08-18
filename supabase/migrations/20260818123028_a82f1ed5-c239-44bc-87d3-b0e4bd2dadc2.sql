-- Fix the classified-movement ('account') branch of bank_match_confirm:
-- build a real balanced line array (bank leg + one leg per allocation).
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
  _lines jsonb;
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
  _inflow boolean;
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
  _inflow := COALESCE(_txn.transaction_type, CASE WHEN _txn.amount >= 0 THEN 'credit' ELSE 'debit' END) = 'credit';

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

  ELSE
    -- Classified bank movement: no AR/AP document, one or more offset accounts.
    SELECT jsonb_build_array(
             jsonb_build_object(
               'account_id', _bank_gl,
               'debit',  CASE WHEN _inflow THEN _net ELSE 0 END,
               'credit', CASE WHEN _inflow THEN 0 ELSE _net END,
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

REVOKE ALL ON FUNCTION public.bank_match_confirm(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bank_match_confirm(uuid, uuid, text) TO authenticated, service_role;
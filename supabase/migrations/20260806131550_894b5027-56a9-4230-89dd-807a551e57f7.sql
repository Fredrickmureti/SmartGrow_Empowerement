CREATE OR REPLACE FUNCTION public.reconcile_bank_transaction_atomic(_txn_id uuid, _recon_type text, _entity_id uuid DEFAULT NULL::uuid, _category text DEFAULT NULL::text, _offset_account_id uuid DEFAULT NULL::uuid, _create_gl boolean DEFAULT true, _user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _txn record;
  _org_id uuid;
  _biz_id uuid;
  _branch_id uuid;
  _bank_gl_account uuid;
  _ar_account uuid;
  _ap_account uuid;
  _je_id uuid;
  _payment_id uuid;
  _bill_payment_id uuid;
  _receipt_number text;
  _abs_amount numeric;
  _entity_record record;
  _match_id uuid;
  _offset_business uuid;
  _offset_branch uuid;
  _settlement jsonb;
BEGIN
  SELECT * INTO _txn FROM public.bank_transactions WHERE id = _txn_id FOR UPDATE;
  IF _txn IS NULL THEN
    RAISE EXCEPTION 'Bank transaction not found: %', _txn_id;
  END IF;
  IF COALESCE(_txn.is_reconciled, false) THEN
    RAISE EXCEPTION 'Bank transaction is already reconciled';
  END IF;

  _org_id := _txn.organization_id;
  _biz_id := _txn.business_id;
  _branch_id := _txn.branch_id;
  _abs_amount := abs(_txn.amount);

  PERFORM public.assert_can_reconcile_bank(_biz_id);

  SELECT account_id INTO _bank_gl_account
  FROM public.bank_accounts
  WHERE id = _txn.bank_account_id
    AND organization_id = _org_id
    AND business_id = _biz_id;

  IF _bank_gl_account IS NULL THEN
    SELECT id INTO _bank_gl_account
    FROM public.accounts
    WHERE organization_id = _org_id
      AND business_id = _biz_id
      AND detail_type = 'checking'
      AND is_active = true
    LIMIT 1;
  END IF;

  IF _offset_account_id IS NOT NULL THEN
    SELECT business_id, branch_id INTO _offset_business, _offset_branch
      FROM public.accounts WHERE id = _offset_account_id;
    IF _offset_business IS DISTINCT FROM _biz_id THEN
      RAISE EXCEPTION 'Manual reconciliation offset account belongs to a different company';
    END IF;
    IF _offset_branch IS NOT NULL AND _branch_id IS NOT NULL AND _offset_branch IS DISTINCT FROM _branch_id THEN
      RAISE EXCEPTION 'Manual reconciliation offset account belongs to a different branch than the bank transaction'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF _recon_type IN ('invoice', 'bill') AND _entity_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.bank_transactions
      WHERE is_reconciled = true
        AND reconciled_entity_id = _entity_id
        AND reconciled_type = _recon_type
        AND id <> _txn_id
    ) THEN
      RAISE EXCEPTION 'This % is already reconciled to another bank transaction', _recon_type;
    END IF;
  END IF;

  IF _recon_type = 'invoice' AND _entity_id IS NOT NULL THEN
    SELECT id INTO _ar_account
    FROM public.accounts
    WHERE organization_id = _org_id
      AND business_id = _biz_id
      AND detail_type = 'accounts_receivable'
      AND is_active = true
    LIMIT 1;

    SELECT total, amount_paid, business_id, contact_id INTO _entity_record
    FROM public.invoices
    WHERE id = _entity_id
    FOR UPDATE;
    IF NOT FOUND OR _entity_record.business_id IS DISTINCT FROM _biz_id THEN
      RAISE EXCEPTION 'Invoice not found in the selected company';
    END IF;

    IF _bank_gl_account IS NULL OR _ar_account IS NULL THEN
      RAISE EXCEPTION 'Cannot reconcile to invoice: bank GL account and Accounts Receivable account must be mapped';
    END IF;

    SELECT public.get_next_receipt_number(_org_id) INTO _receipt_number;
    IF _receipt_number IS NULL THEN
      _receipt_number := 'RCP-BRECON-' || substr(_txn_id::text, 1, 8);
    END IF;

    -- Single settlement engine: reconciliation never writes payments or
    -- journal entries itself; it delegates to the canonical AR engine.
    _settlement := public.record_multi_invoice_payment(
      _org_id := _org_id,
      _business_id := _biz_id,
      _contact_id := _entity_record.contact_id,
      _allocations := jsonb_build_array(jsonb_build_object('invoice_id', _entity_id, 'amount', _abs_amount)),
      _total_amount := _abs_amount,
      _payment_date := _txn.transaction_date,
      _payment_method := 'bank_transfer',
      _reference := coalesce(_txn.reference, 'Bank recon: ' || _txn.description),
      _notes := 'Created by bank reconciliation',
      _receipt_number := _receipt_number,
      _created_by := _user_id,
      _deposit_account_id := _bank_gl_account,
      _receivable_account_id := _ar_account,
      _customer_credit_account_id := NULL,
      _branch_id := _branch_id,
      _exchange_rate := 1
    );

    _payment_id := (_settlement->>'payment_id')::uuid;
    _je_id := NULLIF(_settlement->>'journal_entry_id', '')::uuid;

  ELSIF _recon_type = 'bill' AND _entity_id IS NOT NULL THEN
    SELECT id INTO _ap_account
    FROM public.accounts
    WHERE organization_id = _org_id
      AND business_id = _biz_id
      AND detail_type = 'accounts_payable'
      AND is_active = true
    LIMIT 1;

    SELECT total, amount_paid, business_id, vendor_id INTO _entity_record
    FROM public.bills
    WHERE id = _entity_id
    FOR UPDATE;
    IF NOT FOUND OR _entity_record.business_id IS DISTINCT FROM _biz_id THEN
      RAISE EXCEPTION 'Bill not found in the selected company';
    END IF;

    IF _ap_account IS NULL THEN
      RAISE EXCEPTION 'Cannot reconcile to bill: Accounts Payable account must be mapped';
    END IF;

    _settlement := public.record_multi_bill_payment(
      _org_id := _org_id,
      _business_id := _biz_id,
      _vendor_id := _entity_record.vendor_id,
      _allocations := jsonb_build_array(jsonb_build_object('bill_id', _entity_id, 'amount', _abs_amount)),
      _total_amount := _abs_amount,
      _payment_date := _txn.transaction_date,
      _payment_method := 'bank_transfer',
      _reference := coalesce(_txn.reference, 'Bank recon: ' || _txn.description),
      _notes := 'Created by bank reconciliation',
      _created_by := _user_id,
      _bank_account_id := _txn.bank_account_id,
      _payable_account_id := _ap_account,
      _branch_id := _branch_id
    );

    _bill_payment_id := (_settlement->>'bill_payment_id')::uuid;
    _je_id := NULLIF(_settlement->>'journal_entry_id', '')::uuid;

  ELSIF _recon_type = 'manual' AND _create_gl AND _offset_account_id IS NOT NULL AND _bank_gl_account IS NOT NULL THEN
    _je_id := public.post_journal_entry_atomic(
      _org_id, _biz_id,
      public.generate_next_je_number(_org_id, _biz_id),
      _txn.transaction_date,
      'BRECON-' || substr(_txn_id::text, 1, 8),
      'Bank reconciliation: manual operation',
      'bank_reconciliation', _txn_id, _user_id, false, false,
      CASE WHEN _txn.transaction_type = 'credit' THEN
        jsonb_build_array(
          jsonb_build_object('account_id', _bank_gl_account, 'debit', _abs_amount, 'credit', 0,
            'description', 'Bank deposit: ' || _txn.description),
          jsonb_build_object('account_id', _offset_account_id, 'debit', 0, 'credit', _abs_amount,
            'description', 'Offset: ' || _txn.description)
        )
      ELSE
        jsonb_build_array(
          jsonb_build_object('account_id', _offset_account_id, 'debit', _abs_amount, 'credit', 0,
            'description', 'Offset: ' || _txn.description),
          jsonb_build_object('account_id', _bank_gl_account, 'debit', 0, 'credit', _abs_amount,
            'description', 'Bank withdrawal: ' || _txn.description)
        )
      END,
      NULL, NULL, NULL, _branch_id
    );
  END IF;

  UPDATE public.bank_transactions SET
    is_reconciled = true,
    reconciled_type = _recon_type,
    reconciled_entity_id = _entity_id,
    reconciled_at = now(),
    reconciled_by = _user_id,
    journal_entry_id = _je_id,
    reconciled_payment_id = coalesce(_payment_id, _bill_payment_id),
    category = coalesce(_category, category),
    lifecycle_status = 'reconciled',
    updated_at = now()
  WHERE id = _txn_id;

  INSERT INTO public.bank_reconciliation_matches (
    organization_id, business_id, branch_id, bank_transaction_id,
    matched_journal_entry_id, matched_payment_id, matched_bill_payment_id,
    matched_entity_type, matched_entity_id, matched_amount, residual_amount,
    match_type, status, confidence, notes, created_by, confirmed_by, confirmed_at
  ) VALUES (
    _org_id, _biz_id, _branch_id, _txn_id,
    CASE WHEN _recon_type = 'manual' AND NOT _create_gl THEN _entity_id ELSE _je_id END,
    _payment_id, _bill_payment_id,
    _recon_type, _entity_id, _abs_amount, 0,
    CASE WHEN _create_gl THEN 'manual' ELSE 'suggested' END,
    'confirmed', 1,
    'Confirmed by canonical bank reconciliation RPC',
    _user_id, _user_id, now()
  ) RETURNING id INTO _match_id;

  RETURN jsonb_build_object(
    'success', true,
    'journal_entry_id', _je_id,
    'payment_id', _payment_id,
    'bill_payment_id', _bill_payment_id,
    'reconciliation_match_id', _match_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.reconcile_bank_transfer_atomic(_source_txn_id uuid, _dest_txn_id uuid DEFAULT NULL::uuid, _dest_bank_account_id uuid DEFAULT NULL::uuid, _user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _source_txn record;
  _dest_txn record;
  _source_gl uuid;
  _dest_gl uuid;
  _je_id uuid;
  _org_id uuid;
  _biz_id uuid;
  _abs_amount numeric;
BEGIN
  SELECT * INTO _source_txn FROM bank_transactions WHERE id = _source_txn_id FOR UPDATE;
  IF _source_txn IS NULL THEN RAISE EXCEPTION 'Source transaction not found'; END IF;
  IF _source_txn.is_reconciled THEN RAISE EXCEPTION 'Source transaction is already reconciled'; END IF;

  _org_id := _source_txn.organization_id;
  _biz_id := _source_txn.business_id;
  _abs_amount := abs(_source_txn.amount);

  SELECT account_id INTO _source_gl FROM bank_accounts WHERE id = _source_txn.bank_account_id;
  IF _source_gl IS NULL THEN RAISE EXCEPTION 'Source bank account has no GL account linked'; END IF;

  IF _dest_txn_id IS NOT NULL THEN
    SELECT * INTO _dest_txn FROM bank_transactions WHERE id = _dest_txn_id FOR UPDATE;
    IF _dest_txn IS NULL THEN RAISE EXCEPTION 'Destination transaction not found'; END IF;
    IF _dest_txn.is_reconciled THEN RAISE EXCEPTION 'Destination transaction already reconciled'; END IF;
    SELECT account_id INTO _dest_gl FROM bank_accounts WHERE id = _dest_txn.bank_account_id;
  ELSIF _dest_bank_account_id IS NOT NULL THEN
    SELECT account_id INTO _dest_gl FROM bank_accounts WHERE id = _dest_bank_account_id;
  END IF;

  IF _dest_gl IS NULL THEN RAISE EXCEPTION 'Destination bank account has no GL account linked'; END IF;
  IF _source_gl = _dest_gl THEN RAISE EXCEPTION 'Source and destination cannot be the same GL account'; END IF;

  _je_id := public.post_journal_entry_atomic(
    _org_id, _biz_id,
    public.generate_next_je_number(_org_id, _biz_id),
    _source_txn.transaction_date,
    'BTRANSFER-' || substr(_source_txn_id::text, 1, 8),
    'Bank transfer',
    'bank_transfer', _source_txn_id, _user_id, false, false,
    CASE WHEN _source_txn.transaction_type = 'debit' THEN
      jsonb_build_array(
        jsonb_build_object('account_id', _dest_gl, 'debit', _abs_amount, 'credit', 0, 'description', 'Transfer in'),
        jsonb_build_object('account_id', _source_gl, 'debit', 0, 'credit', _abs_amount, 'description', 'Transfer out')
      )
    ELSE
      jsonb_build_array(
        jsonb_build_object('account_id', _source_gl, 'debit', _abs_amount, 'credit', 0, 'description', 'Transfer in'),
        jsonb_build_object('account_id', _dest_gl, 'debit', 0, 'credit', _abs_amount, 'description', 'Transfer out')
      )
    END,
    NULL, NULL, NULL, _source_txn.branch_id
  );

  UPDATE bank_transactions SET
    is_reconciled = true, reconciled_type = 'transfer',
    reconciled_entity_id = coalesce(_dest_txn_id::text, _dest_bank_account_id::text),
    reconciled_at = now(), reconciled_by = _user_id::text, journal_entry_id = _je_id
  WHERE id = _source_txn_id;

  IF _dest_txn_id IS NOT NULL THEN
    UPDATE bank_transactions SET
      is_reconciled = true, reconciled_type = 'transfer',
      reconciled_entity_id = _source_txn_id::text,
      reconciled_at = now(), reconciled_by = _user_id::text, journal_entry_id = _je_id
    WHERE id = _dest_txn_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'journal_entry_id', _je_id);
END;
$function$;
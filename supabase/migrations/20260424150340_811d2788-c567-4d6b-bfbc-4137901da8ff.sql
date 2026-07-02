CREATE OR REPLACE FUNCTION public.reconcile_bank_transaction_atomic(
  _txn_id uuid,
  _recon_type text,
  _entity_id uuid DEFAULT NULL,
  _category text DEFAULT NULL,
  _offset_account_id uuid DEFAULT NULL,
  _create_gl boolean DEFAULT true,
  _user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  _new_amount_paid numeric;
  _new_status text;
  _je_number text;
  _match_id uuid;
  _offset_business uuid;
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
    SELECT business_id INTO _offset_business FROM public.accounts WHERE id = _offset_account_id;
    IF _offset_business IS DISTINCT FROM _biz_id THEN
      RAISE EXCEPTION 'Manual reconciliation offset account belongs to a different company';
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

    SELECT total, amount_paid, business_id INTO _entity_record
    FROM public.invoices
    WHERE id = _entity_id
    FOR UPDATE;
    IF NOT FOUND OR _entity_record.business_id IS DISTINCT FROM _biz_id THEN
      RAISE EXCEPTION 'Invoice not found in the selected company';
    END IF;

    SELECT public.get_next_receipt_number(_org_id) INTO _receipt_number;
    IF _receipt_number IS NULL THEN
      _receipt_number := 'RCP-BRECON-' || substr(_txn_id::text, 1, 8);
    END IF;

    INSERT INTO public.payments (
      organization_id, business_id, branch_id, invoice_id, amount, payment_date,
      payment_method, reference, created_by, receipt_number, deposit_account_id, status
    ) VALUES (
      _org_id, _biz_id, _branch_id, _entity_id, _abs_amount, _txn.transaction_date,
      'bank_transfer', coalesce(_txn.reference, 'Bank recon: ' || _txn.description),
      _user_id, _receipt_number::text, _bank_gl_account, 'applied'
    ) RETURNING id INTO _payment_id;

    _new_amount_paid := coalesce(_entity_record.amount_paid, 0) + _abs_amount;
    _new_status := CASE WHEN _new_amount_paid >= _entity_record.total THEN 'paid' ELSE 'partial' END;
    UPDATE public.invoices SET amount_paid = _new_amount_paid, status = _new_status WHERE id = _entity_id;

    IF _bank_gl_account IS NOT NULL AND _ar_account IS NOT NULL THEN
      SELECT 'JE-' || to_char(now(), 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6) INTO _je_number;
      INSERT INTO public.journal_entries (
        organization_id, business_id, branch_id, entry_number, entry_date, description, reference,
        source_type, source_id, status, created_by, is_approved, approved_by, approved_at
      ) VALUES (
        _org_id, _biz_id, _branch_id, _je_number, _txn.transaction_date,
        'Bank reconciliation: payment for invoice matched',
        'BRECON-' || substr(_txn_id::text, 1, 8),
        'bank_reconciliation', _txn_id, 'posted', _user_id, true, _user_id, now()
      ) RETURNING id INTO _je_id;

      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, business_id, branch_id, debit, credit, description, sort_order)
      VALUES
        (_je_id, _bank_gl_account, _biz_id, _branch_id, _abs_amount, 0, 'Bank deposit: ' || _txn.description, 0),
        (_je_id, _ar_account, _biz_id, _branch_id, 0, _abs_amount, 'AR cleared: ' || _txn.description, 1);

      UPDATE public.payments SET journal_entry_id = _je_id WHERE id = _payment_id;
    END IF;

  ELSIF _recon_type = 'bill' AND _entity_id IS NOT NULL THEN
    SELECT id INTO _ap_account
    FROM public.accounts
    WHERE organization_id = _org_id
      AND business_id = _biz_id
      AND detail_type = 'accounts_payable'
      AND is_active = true
    LIMIT 1;

    SELECT total, amount_paid, business_id INTO _entity_record
    FROM public.bills
    WHERE id = _entity_id
    FOR UPDATE;
    IF NOT FOUND OR _entity_record.business_id IS DISTINCT FROM _biz_id THEN
      RAISE EXCEPTION 'Bill not found in the selected company';
    END IF;

    INSERT INTO public.bill_payments (
      organization_id, business_id, branch_id, bill_id, amount, payment_date,
      payment_method, reference, created_by, bank_account_id
    ) VALUES (
      _org_id, _biz_id, _branch_id, _entity_id, _abs_amount, _txn.transaction_date,
      'bank_transfer', coalesce(_txn.reference, 'Bank recon: ' || _txn.description),
      _user_id, _txn.bank_account_id
    ) RETURNING id INTO _bill_payment_id;

    _new_amount_paid := coalesce(_entity_record.amount_paid, 0) + _abs_amount;
    _new_status := CASE WHEN _new_amount_paid >= _entity_record.total THEN 'paid' ELSE 'partial' END;
    UPDATE public.bills SET amount_paid = _new_amount_paid, status = _new_status WHERE id = _entity_id;

    IF _bank_gl_account IS NOT NULL AND _ap_account IS NOT NULL THEN
      SELECT 'JE-' || to_char(now(), 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6) INTO _je_number;
      INSERT INTO public.journal_entries (
        organization_id, business_id, branch_id, entry_number, entry_date, description, reference,
        source_type, source_id, status, created_by, is_approved, approved_by, approved_at
      ) VALUES (
        _org_id, _biz_id, _branch_id, _je_number, _txn.transaction_date,
        'Bank reconciliation: bill payment matched',
        'BRECON-' || substr(_txn_id::text, 1, 8),
        'bank_reconciliation', _txn_id, 'posted', _user_id, true, _user_id, now()
      ) RETURNING id INTO _je_id;

      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, business_id, branch_id, debit, credit, description, sort_order)
      VALUES
        (_je_id, _ap_account, _biz_id, _branch_id, _abs_amount, 0, 'AP cleared: ' || _txn.description, 0),
        (_je_id, _bank_gl_account, _biz_id, _branch_id, 0, _abs_amount, 'Bank withdrawal: ' || _txn.description, 1);

      UPDATE public.bill_payments SET journal_entry_id = _je_id WHERE id = _bill_payment_id;
    END IF;

  ELSIF _recon_type = 'manual' AND _create_gl AND _offset_account_id IS NOT NULL AND _bank_gl_account IS NOT NULL THEN
    SELECT 'JE-' || to_char(now(), 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6) INTO _je_number;
    INSERT INTO public.journal_entries (
      organization_id, business_id, branch_id, entry_number, entry_date, description, reference,
      source_type, source_id, status, created_by, is_approved, approved_by, approved_at
    ) VALUES (
      _org_id, _biz_id, _branch_id, _je_number, _txn.transaction_date,
      'Bank reconciliation: manual operation', 'BRECON-' || substr(_txn_id::text, 1, 8),
      'bank_reconciliation', _txn_id, 'posted', _user_id, true, _user_id, now()
    ) RETURNING id INTO _je_id;

    IF _txn.transaction_type = 'credit' THEN
      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, business_id, branch_id, debit, credit, description, sort_order)
      VALUES
        (_je_id, _bank_gl_account, _biz_id, _branch_id, _abs_amount, 0, 'Bank deposit: ' || _txn.description, 0),
        (_je_id, _offset_account_id, _biz_id, _branch_id, 0, _abs_amount, 'Offset: ' || _txn.description, 1);
    ELSE
      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, business_id, branch_id, debit, credit, description, sort_order)
      VALUES
        (_je_id, _offset_account_id, _biz_id, _branch_id, _abs_amount, 0, 'Offset: ' || _txn.description, 0),
        (_je_id, _bank_gl_account, _biz_id, _branch_id, 0, _abs_amount, 'Bank withdrawal: ' || _txn.description, 1);
    END IF;
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
$$;

REVOKE ALL ON FUNCTION public.reconcile_bank_transaction_atomic(uuid, text, uuid, text, uuid, boolean, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.reconcile_bank_transaction_atomic(uuid, text, uuid, text, uuid, boolean, uuid) TO authenticated;
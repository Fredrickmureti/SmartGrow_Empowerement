
-- C2: Add reconciled_payment_id column to bank_transactions for reliable unreconcile
ALTER TABLE public.bank_transactions 
  ADD COLUMN IF NOT EXISTS reconciled_payment_id uuid DEFAULT NULL;

-- C1 + C2: Atomic bank reconciliation RPC for invoice matching
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
BEGIN
  -- Lock the bank transaction row
  SELECT * INTO _txn FROM bank_transactions WHERE id = _txn_id FOR UPDATE;
  IF _txn IS NULL THEN
    RAISE EXCEPTION 'Bank transaction not found: %', _txn_id;
  END IF;
  IF _txn.is_reconciled THEN
    RAISE EXCEPTION 'Bank transaction is already reconciled';
  END IF;

  _org_id := _txn.organization_id;
  _biz_id := _txn.business_id;
  _abs_amount := abs(_txn.amount);

  -- Resolve bank GL account
  SELECT account_id INTO _bank_gl_account 
  FROM bank_accounts WHERE id = _txn.bank_account_id;
  
  IF _bank_gl_account IS NULL THEN
    SELECT id INTO _bank_gl_account FROM accounts 
    WHERE organization_id = _org_id AND detail_type = 'checking' AND is_active = true
    LIMIT 1;
  END IF;

  -- Double-reconciliation guard
  IF _recon_type IN ('invoice', 'bill') AND _entity_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM bank_transactions 
      WHERE is_reconciled = true 
        AND reconciled_entity_id = _entity_id::text
        AND reconciled_type = _recon_type
        AND id != _txn_id
    ) THEN
      RAISE EXCEPTION 'This % is already reconciled to another bank transaction', _recon_type;
    END IF;
  END IF;

  -- ═══ INVOICE RECONCILIATION ═══
  IF _recon_type = 'invoice' AND _entity_id IS NOT NULL THEN
    -- Resolve AR account
    SELECT id INTO _ar_account FROM accounts 
    WHERE organization_id = _org_id AND detail_type = 'accounts_receivable' AND is_active = true
    LIMIT 1;

    -- Get next receipt number
    SELECT public.get_next_receipt_number(_org_id) INTO _receipt_number;
    IF _receipt_number IS NULL THEN
      _receipt_number := 'RCP-BRECON-' || substr(_txn_id::text, 1, 8);
    END IF;

    -- Create payment record
    INSERT INTO payments (
      organization_id, business_id, invoice_id, amount, payment_date,
      payment_method, reference, created_by, receipt_number, deposit_account_id, status
    ) VALUES (
      _org_id, _biz_id, _entity_id, _abs_amount, _txn.transaction_date,
      'bank_transfer', coalesce(_txn.reference, 'Bank recon: ' || _txn.description),
      _user_id, _receipt_number::text, _bank_gl_account, 'applied'
    ) RETURNING id INTO _payment_id;

    -- Update invoice
    SELECT total, amount_paid INTO _entity_record FROM invoices WHERE id = _entity_id FOR UPDATE;
    _new_amount_paid := coalesce(_entity_record.amount_paid, 0) + _abs_amount;
    _new_status := CASE WHEN _new_amount_paid >= _entity_record.total THEN 'paid' ELSE 'partial' END;
    UPDATE invoices SET amount_paid = _new_amount_paid, status = _new_status WHERE id = _entity_id;

    -- Post GL: DR Bank, CR AR
    IF _bank_gl_account IS NOT NULL AND _ar_account IS NOT NULL THEN
      SELECT 'JE-' || to_char(now(), 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6) INTO _je_number;
      
      INSERT INTO journal_entries (
        organization_id, business_id, entry_number, entry_date, description, reference,
        source_type, source_id, status, created_by, is_approved, approved_by, approved_at
      ) VALUES (
        _org_id, _biz_id, _je_number, _txn.transaction_date, 
        'Bank reconciliation: payment for invoice matched',
        'BRECON-' || substr(_txn_id::text, 1, 8),
        'bank_recon', _txn_id::text, 'posted', _user_id, true, _user_id, now()
      ) RETURNING id INTO _je_id;

      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description, sort_order)
      VALUES
        (_je_id, _bank_gl_account, _abs_amount, 0, 'Bank deposit: ' || _txn.description, 0),
        (_je_id, _ar_account, 0, _abs_amount, 'AR cleared: ' || _txn.description, 1);

      -- Link JE to payment
      UPDATE payments SET journal_entry_id = _je_id WHERE id = _payment_id;
    END IF;

  -- ═══ BILL RECONCILIATION ═══
  ELSIF _recon_type = 'bill' AND _entity_id IS NOT NULL THEN
    SELECT id INTO _ap_account FROM accounts 
    WHERE organization_id = _org_id AND detail_type = 'accounts_payable' AND is_active = true
    LIMIT 1;

    INSERT INTO bill_payments (
      organization_id, business_id, bill_id, amount, payment_date,
      payment_method, reference, created_by, bank_account_id
    ) VALUES (
      _org_id, _biz_id, _entity_id, _abs_amount, _txn.transaction_date,
      'bank_transfer', coalesce(_txn.reference, 'Bank recon: ' || _txn.description),
      _user_id, _txn.bank_account_id
    ) RETURNING id INTO _bill_payment_id;

    SELECT total, amount_paid INTO _entity_record FROM bills WHERE id = _entity_id FOR UPDATE;
    _new_amount_paid := coalesce(_entity_record.amount_paid, 0) + _abs_amount;
    _new_status := CASE WHEN _new_amount_paid >= _entity_record.total THEN 'paid' ELSE 'partial' END;
    UPDATE bills SET amount_paid = _new_amount_paid, status = _new_status WHERE id = _entity_id;

    IF _bank_gl_account IS NOT NULL AND _ap_account IS NOT NULL THEN
      SELECT 'JE-' || to_char(now(), 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6) INTO _je_number;

      INSERT INTO journal_entries (
        organization_id, business_id, entry_number, entry_date, description, reference,
        source_type, source_id, status, created_by, is_approved, approved_by, approved_at
      ) VALUES (
        _org_id, _biz_id, _je_number, _txn.transaction_date,
        'Bank reconciliation: bill payment matched',
        'BRECON-' || substr(_txn_id::text, 1, 8),
        'bank_recon', _txn_id::text, 'posted', _user_id, true, _user_id, now()
      ) RETURNING id INTO _je_id;

      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description, sort_order)
      VALUES
        (_je_id, _ap_account, _abs_amount, 0, 'AP cleared: ' || _txn.description, 0),
        (_je_id, _bank_gl_account, 0, _abs_amount, 'Bank withdrawal: ' || _txn.description, 1);

      UPDATE bill_payments SET journal_entry_id = _je_id WHERE id = _bill_payment_id;
    END IF;

  -- ═══ MANUAL RECONCILIATION ═══
  ELSIF _recon_type = 'manual' AND _create_gl AND _offset_account_id IS NOT NULL AND _bank_gl_account IS NOT NULL THEN
    SELECT 'JE-' || to_char(now(), 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6) INTO _je_number;

    INSERT INTO journal_entries (
      organization_id, business_id, entry_number, entry_date, description, reference,
      source_type, source_id, status, created_by, is_approved, approved_by, approved_at
    ) VALUES (
      _org_id, _biz_id, _je_number, _txn.transaction_date,
      'Bank reconciliation: manual match',
      'BRECON-' || substr(_txn_id::text, 1, 8),
      'bank_recon', _txn_id::text, 'posted', _user_id, true, _user_id, now()
    ) RETURNING id INTO _je_id;

    IF _txn.transaction_type = 'credit' THEN
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description, sort_order)
      VALUES
        (_je_id, _bank_gl_account, _abs_amount, 0, 'Bank deposit: ' || _txn.description, 0),
        (_je_id, _offset_account_id, 0, _abs_amount, 'Offset: ' || _txn.description, 1);
    ELSE
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description, sort_order)
      VALUES
        (_je_id, _offset_account_id, _abs_amount, 0, 'Offset: ' || _txn.description, 0),
        (_je_id, _bank_gl_account, 0, _abs_amount, 'Bank withdrawal: ' || _txn.description, 1);
    END IF;
  END IF;

  -- Update bank_transaction — store payment IDs for reliable reversal
  UPDATE bank_transactions SET
    is_reconciled = true,
    reconciled_type = _recon_type,
    reconciled_entity_id = CASE WHEN _entity_id IS NOT NULL THEN _entity_id::text ELSE NULL END,
    reconciled_at = now(),
    reconciled_by = _user_id::text,
    journal_entry_id = _je_id,
    reconciled_payment_id = coalesce(_payment_id, _bill_payment_id),
    category = coalesce(_category, category)
  WHERE id = _txn_id;

  RETURN jsonb_build_object(
    'success', true,
    'journal_entry_id', _je_id,
    'payment_id', _payment_id,
    'bill_payment_id', _bill_payment_id
  );
END;
$$;

-- C5: Atomic journal entry update RPC
CREATE OR REPLACE FUNCTION public.update_journal_entry_atomic(
  _entry_id uuid,
  _entry_date date,
  _description text,
  _reference text DEFAULT NULL,
  _is_adjusting boolean DEFAULT false,
  _is_closing boolean DEFAULT false,
  _lines jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _entry record;
  _total_debit numeric := 0;
  _total_credit numeric := 0;
  _line jsonb;
  _idx int := 0;
BEGIN
  -- Lock and verify entry exists and is draft
  SELECT * INTO _entry FROM journal_entries WHERE id = _entry_id FOR UPDATE;
  IF _entry IS NULL THEN
    RAISE EXCEPTION 'Journal entry not found';
  END IF;
  IF _entry.status != 'draft' THEN
    RAISE EXCEPTION 'Only draft entries can be updated (current status: %)', _entry.status;
  END IF;

  -- Validate lines balance
  FOR _line IN SELECT * FROM jsonb_array_elements(_lines)
  LOOP
    _total_debit := _total_debit + coalesce((_line->>'debit')::numeric, 0);
    _total_credit := _total_credit + coalesce((_line->>'credit')::numeric, 0);
  END LOOP;

  IF abs(_total_debit - _total_credit) > 0.01 THEN
    RAISE EXCEPTION 'Debits (%) must equal credits (%)', _total_debit, _total_credit;
  END IF;

  -- Update header
  UPDATE journal_entries SET
    entry_date = _entry_date,
    description = _description,
    reference = _reference,
    is_adjusting = _is_adjusting,
    is_closing = _is_closing,
    updated_at = now()
  WHERE id = _entry_id;

  -- Delete old lines and insert new ones atomically
  DELETE FROM journal_entry_lines WHERE journal_entry_id = _entry_id;

  FOR _line IN SELECT * FROM jsonb_array_elements(_lines)
  LOOP
    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, description, debit, credit, contact_id, sort_order
    ) VALUES (
      _entry_id,
      (_line->>'account_id')::uuid,
      _line->>'description',
      coalesce((_line->>'debit')::numeric, 0),
      coalesce((_line->>'credit')::numeric, 0),
      CASE WHEN _line->>'contact_id' IS NOT NULL THEN (_line->>'contact_id')::uuid ELSE NULL END,
      _idx
    );
    _idx := _idx + 1;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'entry_id', _entry_id);
END;
$$;


-- Atomic RPC: Record invoice payment + update invoice + create GL journal entry in one transaction
CREATE OR REPLACE FUNCTION public.record_payment_atomic(
  _org_id UUID,
  _business_id UUID,
  _invoice_id UUID,
  _contact_id UUID,
  _amount NUMERIC,
  _payment_date DATE,
  _payment_method TEXT,
  _reference TEXT DEFAULT NULL,
  _notes TEXT DEFAULT NULL,
  _receipt_number TEXT DEFAULT NULL,
  _created_by UUID DEFAULT NULL,
  _cash_account_id UUID DEFAULT NULL,
  _receivable_account_id UUID DEFAULT NULL,
  _je_entry_number TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment_id UUID;
  v_invoice RECORD;
  v_new_amount_paid NUMERIC;
  v_new_status TEXT;
  v_je_id UUID;
  v_result JSONB;
BEGIN
  -- 1. Lock and fetch invoice
  SELECT id, total, amount_paid, status, contact_id
    INTO v_invoice
    FROM invoices
   WHERE id = _invoice_id
     AND organization_id = _org_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  -- 2. Validate payment amount
  IF _amount > (v_invoice.total - COALESCE(v_invoice.amount_paid, 0)) THEN
    RAISE EXCEPTION 'Payment amount (%) exceeds balance due (%)', _amount, (v_invoice.total - COALESCE(v_invoice.amount_paid, 0));
  END IF;

  -- 3. Insert payment
  INSERT INTO payments (
    organization_id, business_id, invoice_id, contact_id, amount,
    payment_date, payment_method, reference, notes, receipt_number, created_by
  ) VALUES (
    _org_id, _business_id, _invoice_id, COALESCE(_contact_id, v_invoice.contact_id), _amount,
    _payment_date, _payment_method, _reference, _notes, _receipt_number, _created_by
  ) RETURNING id INTO v_payment_id;

  -- 4. Update invoice
  v_new_amount_paid := COALESCE(v_invoice.amount_paid, 0) + _amount;
  IF v_new_amount_paid >= v_invoice.total THEN
    v_new_status := 'paid';
  ELSE
    v_new_status := 'partial';
  END IF;

  UPDATE invoices
     SET amount_paid = v_new_amount_paid,
         status = v_new_status
   WHERE id = _invoice_id;

  -- 5. Create GL journal entry (if accounts provided)
  IF _cash_account_id IS NOT NULL AND _receivable_account_id IS NOT NULL THEN
    -- Check idempotency
    SELECT id INTO v_je_id
      FROM journal_entries
     WHERE organization_id = _org_id
       AND source_type = 'payment'
       AND source_id = v_payment_id::TEXT
       AND status != 'voided'
     LIMIT 1;

    IF v_je_id IS NULL THEN
      INSERT INTO journal_entries (
        organization_id, business_id, entry_number, entry_date,
        reference, description, source_type, source_id, status, created_by
      ) VALUES (
        _org_id, _business_id, COALESCE(_je_entry_number, 'JE-' || extract(epoch from now())::TEXT),
        _payment_date, _receipt_number, 'Payment received - ' || _receipt_number,
        'payment', v_payment_id::TEXT, 'posted', _created_by
      ) RETURNING id INTO v_je_id;

      -- Debit Cash/Bank
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
      VALUES (v_je_id, _cash_account_id, _amount, 0, 'Payment ' || _receipt_number || ' - Cash Receipt');

      -- Credit Accounts Receivable
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
      VALUES (v_je_id, _receivable_account_id, 0, _amount, 'Payment ' || _receipt_number || ' - AR Reduction');
    END IF;
  END IF;

  v_result := jsonb_build_object(
    'payment_id', v_payment_id,
    'receipt_number', _receipt_number,
    'journal_entry_id', v_je_id,
    'new_status', v_new_status,
    'new_amount_paid', v_new_amount_paid
  );

  RETURN v_result;
END;
$$;

-- Atomic RPC: Record bill payment + update bill + create GL journal entry in one transaction
CREATE OR REPLACE FUNCTION public.record_bill_payment_atomic(
  _org_id UUID,
  _business_id UUID,
  _bill_id UUID,
  _amount NUMERIC,
  _payment_date DATE,
  _payment_method TEXT DEFAULT 'bank_transfer',
  _reference TEXT DEFAULT NULL,
  _notes TEXT DEFAULT NULL,
  _bank_account_id UUID DEFAULT NULL,
  _created_by UUID DEFAULT NULL,
  _ap_account_id UUID DEFAULT NULL,
  _cash_account_id UUID DEFAULT NULL,
  _je_entry_number TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment_id UUID;
  v_bill RECORD;
  v_new_amount_paid NUMERIC;
  v_new_status TEXT;
  v_je_id UUID;
  v_result JSONB;
BEGIN
  -- 1. Lock and fetch bill
  SELECT id, bill_number, total, amount_paid, status
    INTO v_bill
    FROM bills
   WHERE id = _bill_id
     AND organization_id = _org_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bill not found';
  END IF;

  -- 2. Validate payment amount
  IF _amount > (v_bill.total - COALESCE(v_bill.amount_paid, 0)) THEN
    RAISE EXCEPTION 'Payment amount (%) exceeds balance due (%)', _amount, (v_bill.total - COALESCE(v_bill.amount_paid, 0));
  END IF;

  -- 3. Insert bill payment
  INSERT INTO bill_payments (
    organization_id, business_id, bill_id, amount,
    payment_date, payment_method, reference, notes, bank_account_id, created_by
  ) VALUES (
    _org_id, _business_id, _bill_id, _amount,
    _payment_date, _payment_method, _reference, _notes, _bank_account_id, _created_by
  ) RETURNING id INTO v_payment_id;

  -- 4. Update bill
  v_new_amount_paid := COALESCE(v_bill.amount_paid, 0) + _amount;
  IF v_new_amount_paid >= v_bill.total THEN
    v_new_status := 'paid';
  ELSE
    v_new_status := 'partial';
  END IF;

  UPDATE bills
     SET amount_paid = v_new_amount_paid,
         status = v_new_status
   WHERE id = _bill_id;

  -- 5. Create GL journal entry (if accounts provided)
  IF _ap_account_id IS NOT NULL AND _cash_account_id IS NOT NULL THEN
    SELECT id INTO v_je_id
      FROM journal_entries
     WHERE organization_id = _org_id
       AND source_type = 'bill_payment'
       AND source_id = v_payment_id::TEXT
       AND status != 'voided'
     LIMIT 1;

    IF v_je_id IS NULL THEN
      INSERT INTO journal_entries (
        organization_id, business_id, entry_number, entry_date,
        reference, description, source_type, source_id, status, created_by
      ) VALUES (
        _org_id, _business_id, COALESCE(_je_entry_number, 'JE-' || extract(epoch from now())::TEXT),
        _payment_date, 'BP-' || v_bill.bill_number, 'Bill payment for ' || v_bill.bill_number,
        'bill_payment', v_payment_id::TEXT, 'posted', _created_by
      ) RETURNING id INTO v_je_id;

      -- Debit AP
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
      VALUES (v_je_id, _ap_account_id, _amount, 0, 'Bill payment ' || v_bill.bill_number || ' - AP reduction');

      -- Credit Cash/Bank
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
      VALUES (v_je_id, _cash_account_id, 0, _amount, 'Bill payment ' || v_bill.bill_number || ' - Cash/Bank');

      -- Link JE to payment
      UPDATE bill_payments SET journal_entry_id = v_je_id WHERE id = v_payment_id;
    END IF;
  END IF;

  v_result := jsonb_build_object(
    'payment_id', v_payment_id,
    'journal_entry_id', v_je_id,
    'new_status', v_new_status,
    'new_amount_paid', v_new_amount_paid
  );

  RETURN v_result;
END;
$$;

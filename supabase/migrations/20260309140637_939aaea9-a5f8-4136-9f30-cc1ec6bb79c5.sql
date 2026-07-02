
-- Create a robust atomic JE number generator function with FOR UPDATE locking
CREATE OR REPLACE FUNCTION public.generate_next_je_number(_org_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max_num INT;
  v_next TEXT;
BEGIN
  -- Lock and find the current max entry_number for this org
  -- Using FOR UPDATE to prevent concurrent reads from getting the same number
  SELECT COALESCE(
    MAX(
      CASE 
        WHEN entry_number ~ '^JE-[0-9]+$' 
        THEN CAST(SUBSTRING(entry_number FROM 4) AS INT)
        ELSE 0
      END
    ), 0
  ) INTO v_max_num
  FROM journal_entries
  WHERE organization_id = _org_id
  FOR UPDATE;
  
  v_next := 'JE-' || LPAD((v_max_num + 1)::TEXT, 5, '0');
  RETURN v_next;
END;
$$;

-- Fix record_bill_payment_atomic to generate JE number atomically inside
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
  v_new_status bill_status;
  v_je_id UUID;
  v_je_number TEXT;
  v_result JSONB;
BEGIN
  -- Step 1: Lock the bill row
  SELECT id, bill_number, total, amount_paid, status, journal_entry_id
    INTO v_bill
    FROM bills
   WHERE id = _bill_id
     AND organization_id = _org_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bill not found';
  END IF;

  IF _amount > (v_bill.total - COALESCE(v_bill.amount_paid, 0)) THEN
    RAISE EXCEPTION 'Payment amount (%) exceeds balance due (%)', _amount, (v_bill.total - COALESCE(v_bill.amount_paid, 0));
  END IF;

  -- Step 2: Insert payment record
  INSERT INTO bill_payments (
    organization_id, business_id, bill_id, amount,
    payment_date, payment_method, reference, notes, bank_account_id, created_by
  ) VALUES (
    _org_id, _business_id, _bill_id, _amount,
    _payment_date, _payment_method, _reference, _notes, _bank_account_id, _created_by
  ) RETURNING id INTO v_payment_id;

  -- Step 3: Calculate new status
  v_new_amount_paid := COALESCE(v_bill.amount_paid, 0) + _amount;
  IF v_new_amount_paid >= v_bill.total THEN
    v_new_status := 'paid';
  ELSE
    v_new_status := 'partial';
  END IF;

  v_je_id := v_bill.journal_entry_id;

  -- Step 4: Create journal entry with ATOMIC number generation
  IF _ap_account_id IS NOT NULL AND _cash_account_id IS NOT NULL THEN
    -- Generate JE number atomically inside this transaction
    v_je_number := generate_next_je_number(_org_id);

    INSERT INTO journal_entries (
      organization_id, business_id, entry_number, entry_date,
      reference, description, source_type, source_id, status, created_by
    ) VALUES (
      _org_id, _business_id, v_je_number,
      _payment_date, 'BP-' || v_bill.bill_number, 'Bill payment for ' || v_bill.bill_number,
      'bill_payment', v_payment_id, 'posted', _created_by
    ) RETURNING id INTO v_je_id;

    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
    VALUES (v_je_id, _ap_account_id, _amount, 0, 'Bill payment ' || v_bill.bill_number || ' - AP reduction');

    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
    VALUES (v_je_id, _cash_account_id, 0, _amount, 'Bill payment ' || v_bill.bill_number || ' - Cash/Bank');

    UPDATE bill_payments SET journal_entry_id = v_je_id WHERE id = v_payment_id;
  END IF;

  -- Step 5: Update bill
  UPDATE bills
     SET amount_paid = v_new_amount_paid,
         status = v_new_status,
         journal_entry_id = v_je_id
   WHERE id = _bill_id;

  v_result := jsonb_build_object(
    'payment_id', v_payment_id,
    'journal_entry_id', v_je_id,
    'new_status', v_new_status::TEXT,
    'new_amount_paid', v_new_amount_paid
  );

  RETURN v_result;
END;
$$;

-- Also fix record_payment_atomic (sales invoice payments) with same atomic numbering
CREATE OR REPLACE FUNCTION public.record_payment_atomic(
  _org_id UUID,
  _business_id UUID,
  _invoice_id UUID,
  _contact_id UUID,
  _amount NUMERIC,
  _payment_date DATE,
  _payment_method TEXT DEFAULT 'bank_transfer',
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
  v_je_number TEXT;
  v_result JSONB;
BEGIN
  -- Lock the invoice row
  SELECT id, invoice_number, total, amount_paid, status
    INTO v_invoice
    FROM invoices
   WHERE id = _invoice_id
     AND organization_id = _org_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  IF _amount > (v_invoice.total - COALESCE(v_invoice.amount_paid, 0)) THEN
    RAISE EXCEPTION 'Payment amount exceeds balance due';
  END IF;

  -- Insert payment
  INSERT INTO payments (
    organization_id, business_id, invoice_id, contact_id, amount,
    payment_date, payment_method, reference, notes, receipt_number, created_by
  ) VALUES (
    _org_id, _business_id, _invoice_id, _contact_id, _amount,
    _payment_date, _payment_method, _reference, _notes, _receipt_number, _created_by
  ) RETURNING id INTO v_payment_id;

  -- Calculate new status
  v_new_amount_paid := COALESCE(v_invoice.amount_paid, 0) + _amount;
  IF v_new_amount_paid >= v_invoice.total THEN
    v_new_status := 'paid';
  ELSE
    v_new_status := 'partial';
  END IF;

  -- Create journal entry with ATOMIC number generation
  IF _cash_account_id IS NOT NULL AND _receivable_account_id IS NOT NULL THEN
    -- Generate JE number atomically
    v_je_number := generate_next_je_number(_org_id);

    INSERT INTO journal_entries (
      organization_id, business_id, entry_number, entry_date,
      reference, description, source_type, source_id, status, created_by
    ) VALUES (
      _org_id, _business_id, v_je_number,
      _payment_date, 'PMT-' || v_invoice.invoice_number, 'Payment for invoice ' || v_invoice.invoice_number,
      'payment', v_payment_id, 'posted', _created_by
    ) RETURNING id INTO v_je_id;

    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
    VALUES (v_je_id, _cash_account_id, _amount, 0, 'Payment received - ' || v_invoice.invoice_number);

    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
    VALUES (v_je_id, _receivable_account_id, 0, _amount, 'AR reduction - ' || v_invoice.invoice_number);

    UPDATE payments SET journal_entry_id = v_je_id WHERE id = v_payment_id;
  END IF;

  -- Update invoice
  UPDATE invoices
     SET amount_paid = v_new_amount_paid,
         status = v_new_status
   WHERE id = _invoice_id;

  v_result := jsonb_build_object(
    'payment_id', v_payment_id,
    'journal_entry_id', v_je_id,
    'new_status', v_new_status,
    'new_amount_paid', v_new_amount_paid
  );

  RETURN v_result;
END;
$$;

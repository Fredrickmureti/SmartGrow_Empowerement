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
  v_result JSONB;
BEGIN
  -- 1. Lock and fetch bill
  SELECT id, bill_number, total, amount_paid, status, journal_entry_id
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

  -- 4. Calculate new status
  v_new_amount_paid := COALESCE(v_bill.amount_paid, 0) + _amount;
  IF v_new_amount_paid >= v_bill.total THEN
    v_new_status := 'paid';
  ELSE
    v_new_status := 'partial';
  END IF;

  -- 5. Create GL journal entry BEFORE updating bill status (trigger requires journal_entry_id)
  v_je_id := v_bill.journal_entry_id; -- preserve existing JE if any

  IF _ap_account_id IS NOT NULL AND _cash_account_id IS NOT NULL THEN
    -- Check if a payment JE already exists for this specific payment
    INSERT INTO journal_entries (
      organization_id, business_id, entry_number, entry_date,
      reference, description, source_type, source_id, status, created_by
    ) VALUES (
      _org_id, _business_id, COALESCE(_je_entry_number, 'JE-' || extract(epoch from now())::TEXT),
      _payment_date, 'BP-' || v_bill.bill_number, 'Bill payment for ' || v_bill.bill_number,
      'bill_payment', v_payment_id::TEXT, 'posted', _created_by
    ) RETURNING id INTO v_je_id;

    -- Debit AP (reduce liability)
    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
    VALUES (v_je_id, _ap_account_id, _amount, 0, 'Bill payment ' || v_bill.bill_number || ' - AP reduction');

    -- Credit Cash/Bank
    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
    VALUES (v_je_id, _cash_account_id, 0, _amount, 'Bill payment ' || v_bill.bill_number || ' - Cash/Bank');

    -- Link JE to payment record
    UPDATE bill_payments SET journal_entry_id = v_je_id WHERE id = v_payment_id;
  END IF;

  -- 6. Update bill with BOTH status and journal_entry_id (trigger validates this)
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
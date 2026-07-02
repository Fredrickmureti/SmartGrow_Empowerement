CREATE OR REPLACE FUNCTION public.generate_next_je_number(_org_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_num INT;
  v_current_max INT;
BEGIN
  -- Self-heal against legacy/parallel writers that may have inserted higher JE numbers
  SELECT COALESCE(MAX(
    CASE
      WHEN entry_number ~ '^JE-[0-9]+$' THEN CAST(SUBSTRING(entry_number FROM 4) AS INT)
      ELSE 0
    END
  ), 0)
    INTO v_current_max
    FROM public.journal_entries
   WHERE organization_id = _org_id;

  INSERT INTO public.je_number_sequences (organization_id, last_number)
  VALUES (_org_id, v_current_max)
  ON CONFLICT (organization_id)
  DO UPDATE SET last_number = GREATEST(public.je_number_sequences.last_number, EXCLUDED.last_number);

  UPDATE public.je_number_sequences
     SET last_number = last_number + 1
   WHERE organization_id = _org_id
   RETURNING last_number INTO v_num;

  RETURN 'JE-' || LPAD(v_num::TEXT, 5, '0');
END;
$$;

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
SET search_path TO 'public'
AS $$
DECLARE
  v_payment_id UUID;
  v_bill RECORD;
  v_new_amount_paid NUMERIC;
  v_new_status bill_status;
  v_je_id UUID;
  v_je_number TEXT;
  v_result JSONB;
  v_attempts INT := 0;
  v_max_attempts INT := 20;
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
    v_new_status := 'paid'::bill_status;
  ELSE
    v_new_status := 'partial'::bill_status;
  END IF;

  v_je_id := v_bill.journal_entry_id;

  -- Step 4: Create journal entry with collision-safe allocation
  IF _ap_account_id IS NOT NULL AND _cash_account_id IS NOT NULL THEN
    LOOP
      v_attempts := v_attempts + 1;

      IF v_attempts > v_max_attempts THEN
        RAISE EXCEPTION 'Unable to allocate unique journal entry number after % attempts for org %', v_max_attempts, _org_id;
      END IF;

      v_je_number := generate_next_je_number(_org_id);

      BEGIN
        INSERT INTO journal_entries (
          organization_id, business_id, entry_number, entry_date,
          reference, description, source_type, source_id, status, created_by
        ) VALUES (
          _org_id, _business_id, v_je_number,
          _payment_date, 'BP-' || v_bill.bill_number, 'Bill payment for ' || v_bill.bill_number,
          'bill_payment', v_payment_id, 'posted', _created_by
        ) RETURNING id INTO v_je_id;

        EXIT; -- success
      EXCEPTION
        WHEN unique_violation THEN
          -- If JE number collides (e.g., legacy writer inserted same number), retry with next one
          IF POSITION('journal_entries_organization_id_entry_number_key' IN SQLERRM) > 0 THEN
            CONTINUE;
          ELSE
            RAISE;
          END IF;
      END;
    END LOOP;

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
    'journal_entry_number', v_je_number,
    'new_status', v_new_status::TEXT,
    'new_amount_paid', v_new_amount_paid,
    'je_number_attempts', v_attempts
  );

  RETURN v_result;
END;
$$;
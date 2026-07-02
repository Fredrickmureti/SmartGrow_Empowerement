
-- =====================================================
-- Customer Overpayment & Advance Payment Support
-- =====================================================

-- 1. Update record_payment_atomic to handle overpayments
--    When _amount > balance_due: pay invoice fully, auto-create credit note for excess
--    New param: _customer_credit_account_id for the liability GL account
CREATE OR REPLACE FUNCTION public.record_payment_atomic(
  _org_id uuid,
  _business_id uuid,
  _invoice_id uuid,
  _contact_id uuid,
  _amount numeric,
  _payment_date date,
  _payment_method text DEFAULT 'bank_transfer'::text,
  _reference text DEFAULT NULL::text,
  _notes text DEFAULT NULL::text,
  _receipt_number text DEFAULT NULL::text,
  _created_by uuid DEFAULT NULL::uuid,
  _cash_account_id uuid DEFAULT NULL::uuid,
  _receivable_account_id uuid DEFAULT NULL::uuid,
  _je_entry_number text DEFAULT NULL::text,
  _customer_credit_account_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_payment_id UUID;
  v_invoice RECORD;
  v_balance_due NUMERIC;
  v_overpayment NUMERIC := 0;
  v_applied_to_invoice NUMERIC;
  v_new_amount_paid NUMERIC;
  v_new_status TEXT;
  v_je_id UUID;
  v_je_number TEXT;
  v_result JSONB;
  v_retry INT := 0;
  v_max_retries INT := 5;
  v_credit_note_id UUID;
  v_cn_number TEXT;
BEGIN
  -- Lock and fetch invoice
  SELECT id, invoice_number, total, amount_paid, status
    INTO v_invoice
    FROM invoices
   WHERE id = _invoice_id
     AND organization_id = _org_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  v_balance_due := v_invoice.total - COALESCE(v_invoice.amount_paid, 0);

  -- Determine how much applies to invoice vs overpayment
  IF _amount > v_balance_due THEN
    v_applied_to_invoice := v_balance_due;
    v_overpayment := _amount - v_balance_due;
  ELSE
    v_applied_to_invoice := _amount;
    v_overpayment := 0;
  END IF;

  -- Insert payment record (full amount)
  INSERT INTO payments (
    organization_id, business_id, invoice_id, contact_id, amount,
    payment_date, payment_method, reference, notes, receipt_number, created_by
  ) VALUES (
    _org_id, _business_id, _invoice_id, _contact_id, _amount,
    _payment_date, _payment_method::payment_method, _reference, _notes, _receipt_number, _created_by
  ) RETURNING id INTO v_payment_id;

  -- Calculate new invoice status
  v_new_amount_paid := COALESCE(v_invoice.amount_paid, 0) + v_applied_to_invoice;
  IF v_new_amount_paid >= v_invoice.total THEN
    v_new_status := 'paid';
  ELSE
    v_new_status := 'partial';
  END IF;

  -- Create journal entry
  IF _cash_account_id IS NOT NULL AND _receivable_account_id IS NOT NULL THEN
    LOOP
      BEGIN
        v_je_number := generate_next_je_number(_org_id);

        INSERT INTO journal_entries (
          organization_id, business_id, entry_number, entry_date,
          reference, description, source_type, source_id, status, created_by
        ) VALUES (
          _org_id, _business_id, v_je_number,
          _payment_date, 'PMT-' || v_invoice.invoice_number,
          'Payment for invoice ' || v_invoice.invoice_number,
          'payment', v_payment_id, 'posted', _created_by
        ) RETURNING id INTO v_je_id;

        EXIT;
      EXCEPTION WHEN unique_violation THEN
        v_retry := v_retry + 1;
        IF v_retry >= v_max_retries THEN
          RAISE EXCEPTION 'Could not generate unique JE number after % retries', v_max_retries;
        END IF;
      END;
    END LOOP;

    -- Dr Cash (full amount received)
    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
    VALUES (v_je_id, _cash_account_id, _amount, 0, 'Payment received - ' || v_invoice.invoice_number);

    -- Cr Accounts Receivable (amount applied to invoice)
    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
    VALUES (v_je_id, _receivable_account_id, 0, v_applied_to_invoice, 'AR reduction - ' || v_invoice.invoice_number);

    -- Cr Customer Credit (overpayment portion, if any)
    IF v_overpayment > 0 AND _customer_credit_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
      VALUES (v_je_id, _customer_credit_account_id, 0, v_overpayment, 'Customer overpayment credit - ' || v_invoice.invoice_number);
    END IF;

    UPDATE payments SET journal_entry_id = v_je_id WHERE id = v_payment_id;
  END IF;

  -- Update invoice
  UPDATE invoices
     SET amount_paid = v_new_amount_paid,
         status = v_new_status::invoice_status
   WHERE id = _invoice_id;

  -- Auto-create credit note for overpayment
  IF v_overpayment > 0 THEN
    v_cn_number := get_next_credit_note_number(_org_id);

    INSERT INTO credit_notes (
      organization_id, business_id, contact_id, invoice_id,
      credit_note_number, status, issue_date,
      subtotal, tax_amount, total, amount_applied,
      currency, reason, notes, created_by
    ) VALUES (
      _org_id, _business_id, _contact_id, _invoice_id,
      v_cn_number, 'issued'::credit_note_status, _payment_date,
      v_overpayment, 0, v_overpayment, 0,
      COALESCE((SELECT currency FROM invoices WHERE id = _invoice_id), 'USD'),
      'Overpayment on invoice ' || v_invoice.invoice_number,
      'Auto-generated from overpayment. Receipt: ' || COALESCE(_receipt_number, 'N/A'),
      _created_by
    ) RETURNING id INTO v_credit_note_id;
  END IF;

  v_result := jsonb_build_object(
    'payment_id', v_payment_id,
    'journal_entry_id', v_je_id,
    'new_status', v_new_status,
    'new_amount_paid', v_new_amount_paid,
    'overpayment_amount', v_overpayment,
    'credit_note_id', v_credit_note_id
  );

  RETURN v_result;
END;
$function$;

-- 2. Create record_advance_payment RPC for payments without an invoice
CREATE OR REPLACE FUNCTION public.record_advance_payment(
  _org_id uuid,
  _business_id uuid,
  _contact_id uuid,
  _amount numeric,
  _payment_date date,
  _payment_method text DEFAULT 'bank_transfer'::text,
  _reference text DEFAULT NULL::text,
  _notes text DEFAULT NULL::text,
  _receipt_number text DEFAULT NULL::text,
  _created_by uuid DEFAULT NULL::uuid,
  _cash_account_id uuid DEFAULT NULL::uuid,
  _advance_liability_account_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_payment_id UUID;
  v_je_id UUID;
  v_je_number TEXT;
  v_credit_note_id UUID;
  v_cn_number TEXT;
  v_retry INT := 0;
  v_max_retries INT := 5;
  v_contact_name TEXT;
  v_currency TEXT := 'USD';
BEGIN
  IF _amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive';
  END IF;

  -- Get contact name for descriptions
  SELECT name INTO v_contact_name FROM contacts WHERE id = _contact_id AND organization_id = _org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contact not found';
  END IF;

  -- Get org currency
  SELECT COALESCE(currency, 'USD') INTO v_currency FROM organizations WHERE id = _org_id;

  -- Insert payment record (no invoice_id)
  INSERT INTO payments (
    organization_id, business_id, invoice_id, contact_id, amount,
    payment_date, payment_method, reference, notes, receipt_number, created_by
  ) VALUES (
    _org_id, _business_id, NULL, _contact_id, _amount,
    _payment_date, _payment_method::payment_method, _reference, _notes, _receipt_number, _created_by
  ) RETURNING id INTO v_payment_id;

  -- Create journal entry: Dr Cash, Cr Customer Advance Liability
  IF _cash_account_id IS NOT NULL AND _advance_liability_account_id IS NOT NULL THEN
    LOOP
      BEGIN
        v_je_number := generate_next_je_number(_org_id);

        INSERT INTO journal_entries (
          organization_id, business_id, entry_number, entry_date,
          reference, description, source_type, source_id, status, created_by
        ) VALUES (
          _org_id, _business_id, v_je_number,
          _payment_date, 'ADV-' || COALESCE(_receipt_number, v_payment_id::text),
          'Advance payment from ' || v_contact_name,
          'payment', v_payment_id, 'posted', _created_by
        ) RETURNING id INTO v_je_id;

        EXIT;
      EXCEPTION WHEN unique_violation THEN
        v_retry := v_retry + 1;
        IF v_retry >= v_max_retries THEN
          RAISE EXCEPTION 'Could not generate unique JE number after % retries', v_max_retries;
        END IF;
      END;
    END LOOP;

    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
    VALUES (v_je_id, _cash_account_id, _amount, 0, 'Advance payment from ' || v_contact_name);

    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
    VALUES (v_je_id, _advance_liability_account_id, 0, _amount, 'Customer advance liability - ' || v_contact_name);

    UPDATE payments SET journal_entry_id = v_je_id WHERE id = v_payment_id;
  END IF;

  -- Auto-create credit note for the full advance amount
  v_cn_number := get_next_credit_note_number(_org_id);

  INSERT INTO credit_notes (
    organization_id, business_id, contact_id, invoice_id,
    credit_note_number, status, issue_date,
    subtotal, tax_amount, total, amount_applied,
    currency, reason, notes, created_by
  ) VALUES (
    _org_id, _business_id, _contact_id, NULL,
    v_cn_number, 'issued'::credit_note_status, _payment_date,
    _amount, 0, _amount, 0,
    v_currency,
    'Advance payment from ' || v_contact_name,
    'Auto-generated from advance payment. Receipt: ' || COALESCE(_receipt_number, 'N/A'),
    _created_by
  ) RETURNING id INTO v_credit_note_id;

  RETURN jsonb_build_object(
    'payment_id', v_payment_id,
    'journal_entry_id', v_je_id,
    'credit_note_id', v_credit_note_id,
    'credit_note_number', v_cn_number,
    'receipt_number', _receipt_number
  );
END;
$function$;

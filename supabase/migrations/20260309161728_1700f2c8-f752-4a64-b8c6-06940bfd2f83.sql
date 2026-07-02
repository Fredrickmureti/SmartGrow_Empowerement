-- Fix: Cast _payment_method TEXT to payment_method enum in the INSERT
-- Also add retry loop for JE number collisions (matching bill_payment_atomic pattern)
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
  _je_entry_number text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_payment_id UUID;
  v_invoice RECORD;
  v_new_amount_paid NUMERIC;
  v_new_status TEXT;
  v_je_id UUID;
  v_je_number TEXT;
  v_result JSONB;
  v_retry INT := 0;
  v_max_retries INT := 5;
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

  -- Insert payment with explicit enum cast
  INSERT INTO payments (
    organization_id, business_id, invoice_id, contact_id, amount,
    payment_date, payment_method, reference, notes, receipt_number, created_by
  ) VALUES (
    _org_id, _business_id, _invoice_id, _contact_id, _amount,
    _payment_date, _payment_method::payment_method, _reference, _notes, _receipt_number, _created_by
  ) RETURNING id INTO v_payment_id;

  -- Calculate new status
  v_new_amount_paid := COALESCE(v_invoice.amount_paid, 0) + _amount;
  IF v_new_amount_paid >= v_invoice.total THEN
    v_new_status := 'paid';
  ELSE
    v_new_status := 'partial';
  END IF;

  -- Create journal entry with collision-safe JE number generation
  IF _cash_account_id IS NOT NULL AND _receivable_account_id IS NOT NULL THEN
    LOOP
      BEGIN
        v_je_number := generate_next_je_number(_org_id);

        INSERT INTO journal_entries (
          organization_id, business_id, entry_number, entry_date,
          reference, description, source_type, source_id, status, created_by
        ) VALUES (
          _org_id, _business_id, v_je_number,
          _payment_date, 'PMT-' || v_invoice.invoice_number, 'Payment for invoice ' || v_invoice.invoice_number,
          'payment', v_payment_id, 'posted', _created_by
        ) RETURNING id INTO v_je_id;

        EXIT; -- Success, exit retry loop
      EXCEPTION WHEN unique_violation THEN
        v_retry := v_retry + 1;
        IF v_retry >= v_max_retries THEN
          RAISE EXCEPTION 'Could not generate unique JE number after % retries', v_max_retries;
        END IF;
      END;
    END LOOP;

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
$function$;
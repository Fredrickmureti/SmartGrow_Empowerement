CREATE OR REPLACE FUNCTION public.record_multi_invoice_payment(
  _org_id uuid,
  _business_id uuid,
  _contact_id uuid,
  _allocations jsonb,
  _total_amount numeric,
  _payment_date date,
  _payment_method text DEFAULT 'bank_transfer'::text,
  _reference text DEFAULT NULL::text,
  _notes text DEFAULT NULL::text,
  _receipt_number text DEFAULT NULL::text,
  _created_by uuid DEFAULT NULL::uuid,
  _deposit_account_id uuid DEFAULT NULL::uuid,
  _receivable_account_id uuid DEFAULT NULL::uuid,
  _customer_credit_account_id uuid DEFAULT NULL::uuid
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
  v_retry INT := 0;
  v_max_retries INT := 5;
  v_alloc RECORD;
  v_invoice RECORD;
  v_sum_allocated NUMERIC := 0;
  v_excess NUMERIC := 0;
  v_new_amount_paid NUMERIC;
  v_new_status TEXT;
  v_invoice_statuses JSONB := '[]'::jsonb;
  v_contact_name TEXT;
  v_currency TEXT := 'USD';
  v_credit_note_id UUID;
  v_cn_number TEXT;
BEGIN
  IF _deposit_account_id IS NULL THEN
    RAISE EXCEPTION 'Deposit account is required for multi-invoice payment.';
  END IF;
  IF _receivable_account_id IS NULL THEN
    RAISE EXCEPTION 'Accounts Receivable account is required.';
  END IF;
  IF _total_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive.';
  END IF;

  SELECT name INTO v_contact_name FROM contacts WHERE id = _contact_id AND organization_id = _org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contact not found';
  END IF;

  -- Currency lives on the workspace's business, not on the organization.
  SELECT COALESCE(b.base_currency, 'USD')
    INTO v_currency
    FROM businesses b
   WHERE b.id = _business_id;
  IF v_currency IS NULL THEN
    v_currency := 'USD';
  END IF;

  INSERT INTO payments (
    organization_id, business_id, invoice_id, contact_id, amount,
    payment_date, payment_method, reference, notes, receipt_number, created_by,
    deposit_account_id
  ) VALUES (
    _org_id, _business_id, NULL, _contact_id, _total_amount,
    _payment_date, _payment_method::payment_method, _reference, _notes, _receipt_number, _created_by,
    _deposit_account_id
  ) RETURNING id INTO v_payment_id;

  FOR v_alloc IN SELECT * FROM jsonb_to_recordset(_allocations) AS x(invoice_id uuid, amount numeric)
  LOOP
    IF v_alloc.amount <= 0 THEN
      CONTINUE;
    END IF;

    SELECT id, invoice_number, total, amount_paid
      INTO v_invoice
      FROM invoices
     WHERE id = v_alloc.invoice_id AND organization_id = _org_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invoice % not found', v_alloc.invoice_id;
    END IF;

    INSERT INTO payment_allocations (payment_id, invoice_id, amount)
    VALUES (v_payment_id, v_alloc.invoice_id, v_alloc.amount);

    v_new_amount_paid := COALESCE(v_invoice.amount_paid, 0) + v_alloc.amount;
    IF v_new_amount_paid >= v_invoice.total THEN
      v_new_status := 'paid';
    ELSE
      v_new_status := 'partial';
    END IF;

    UPDATE invoices
       SET amount_paid = v_new_amount_paid,
           status = v_new_status::invoice_status
     WHERE id = v_alloc.invoice_id;

    v_sum_allocated := v_sum_allocated + v_alloc.amount;

    v_invoice_statuses := v_invoice_statuses || jsonb_build_object(
      'invoice_id', v_alloc.invoice_id,
      'new_status', v_new_status,
      'new_amount_paid', v_new_amount_paid
    );
  END LOOP;

  v_excess := _total_amount - v_sum_allocated;

  IF v_excess > 0 AND _customer_credit_account_id IS NULL THEN
    RAISE EXCEPTION 'Customer credit account not configured. Cannot process excess amount of %.', v_excess;
  END IF;

  LOOP
    BEGIN
      v_je_number := generate_next_je_number(_org_id);

      INSERT INTO journal_entries (
        organization_id, business_id, entry_number, entry_date,
        reference, description, source_type, source_id, status, created_by
      ) VALUES (
        _org_id, _business_id, v_je_number,
        _payment_date, 'PMT-' || COALESCE(_receipt_number, v_payment_id::text),
        'Payment from ' || v_contact_name,
        'payment', v_payment_id, 'posted', _created_by
      ) RETURNING id INTO v_je_id;

      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_retry := v_retry + 1;
      IF v_retry >= v_max_retries THEN
        RAISE EXCEPTION 'Failed to generate unique journal entry number after % attempts', v_max_retries;
      END IF;
    END;
  END LOOP;

  -- Dr Cash/Bank
  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
  VALUES (v_je_id, _deposit_account_id, _total_amount, 0,
          'Payment received from ' || v_contact_name);

  -- Cr A/R for the allocated portion
  IF v_sum_allocated > 0 THEN
    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
    VALUES (v_je_id, _receivable_account_id, 0, v_sum_allocated,
            'Allocated to invoices');
  END IF;

  -- Cr Customer Credit (advance) for any excess
  IF v_excess > 0 THEN
    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
    VALUES (v_je_id, _customer_credit_account_id, 0, v_excess,
            'Customer advance / overpayment');

    -- Optional: open a credit note draft for traceability if your schema supports it.
    BEGIN
      v_cn_number := 'ADV-' || to_char(now(), 'YYYYMMDDHH24MISS');
      INSERT INTO credit_notes (
        organization_id, business_id, contact_id, credit_note_number,
        issue_date, total, status, notes, created_by
      ) VALUES (
        _org_id, _business_id, _contact_id, v_cn_number,
        _payment_date, v_excess, 'draft', 'Auto-created from overpayment', _created_by
      ) RETURNING id INTO v_credit_note_id;
    EXCEPTION WHEN OTHERS THEN
      v_credit_note_id := NULL;
    END;
  END IF;

  RETURN jsonb_build_object(
    'payment_id', v_payment_id,
    'journal_entry_id', v_je_id,
    'currency', v_currency,
    'allocated', v_sum_allocated,
    'excess', v_excess,
    'credit_note_id', v_credit_note_id,
    'invoice_statuses', v_invoice_statuses
  );
END;
$function$;
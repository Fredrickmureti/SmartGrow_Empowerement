-- Surgical fix for payment posting failures
-- 1) Fix invoice status type mismatch in the active record_payment_atomic overload
-- 2) Fix invalid enum label in legacy overload ('partially_paid' -> 'partial')

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
  _deposit_account_id uuid DEFAULT NULL::uuid,
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
  v_new_status invoice_status;
  v_je_id UUID;
  v_je_number TEXT;
  v_result JSONB;
  v_retry INT := 0;
  v_max_retries INT := 5;
  v_credit_note_id UUID;
  v_cn_number TEXT;
  v_currency TEXT := 'USD';
BEGIN
  IF _deposit_account_id IS NULL THEN
    RAISE EXCEPTION 'Deposit account is required. Cannot record payment without a valid GL deposit account.';
  END IF;
  IF _receivable_account_id IS NULL THEN
    RAISE EXCEPTION 'Accounts Receivable account is required. Cannot record payment without a valid AR account.';
  END IF;

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

  IF _amount > v_balance_due THEN
    v_applied_to_invoice := v_balance_due;
    v_overpayment := _amount - v_balance_due;
  ELSE
    v_applied_to_invoice := _amount;
    v_overpayment := 0;
  END IF;

  IF v_overpayment > 0 AND _customer_credit_account_id IS NULL THEN
    RAISE EXCEPTION 'Customer credit account not configured. Cannot process overpayment of %. Please configure the Customer Deposits & Advances account in Finance Settings.', v_overpayment;
  END IF;

  SELECT COALESCE(base_currency, 'USD') INTO v_currency FROM organizations WHERE id = _org_id;

  INSERT INTO payments (
    organization_id, business_id, invoice_id, contact_id, amount,
    payment_date, payment_method, reference, notes, receipt_number, created_by,
    deposit_account_id
  ) VALUES (
    _org_id, _business_id, _invoice_id, _contact_id, _amount,
    _payment_date, _payment_method::payment_method, _reference, _notes, _receipt_number, _created_by,
    _deposit_account_id
  ) RETURNING id INTO v_payment_id;

  v_new_amount_paid := COALESCE(v_invoice.amount_paid, 0) + v_applied_to_invoice;
  IF v_new_amount_paid >= v_invoice.total THEN
    v_new_status := 'paid'::invoice_status;
  ELSE
    v_new_status := 'partial'::invoice_status;
  END IF;

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

  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
  VALUES (v_je_id, _deposit_account_id, _amount, 0, 'Payment received - ' || v_invoice.invoice_number);

  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
  VALUES (v_je_id, _receivable_account_id, 0, v_applied_to_invoice, 'AR settlement - ' || v_invoice.invoice_number);

  IF v_overpayment > 0 THEN
    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
    VALUES (v_je_id, _customer_credit_account_id, 0, v_overpayment, 'Customer overpayment credit - ' || v_invoice.invoice_number);
  END IF;

  UPDATE payments SET journal_entry_id = v_je_id, status = 'applied' WHERE id = v_payment_id;

  UPDATE invoices
     SET amount_paid = v_new_amount_paid,
         status = v_new_status,
         updated_at = NOW()
   WHERE id = _invoice_id;

  IF v_overpayment > 0 THEN
    v_cn_number := 'CN-OVR-' || LPAD((
      SELECT COALESCE(COUNT(*), 0) + 1
        FROM credit_notes
       WHERE organization_id = _org_id
    )::TEXT, 4, '0');

    INSERT INTO credit_notes (
      organization_id, business_id, contact_id, invoice_id,
      credit_note_number, status, issue_date,
      subtotal, tax_amount, total, currency, reason, created_by
    ) VALUES (
      _org_id, _business_id, _contact_id, _invoice_id,
      v_cn_number, 'issued', _payment_date,
      v_overpayment, 0, v_overpayment, v_currency,
      'Auto-generated from overpayment on invoice ' || v_invoice.invoice_number,
      _created_by
    ) RETURNING id INTO v_credit_note_id;
  END IF;

  v_result := jsonb_build_object(
    'payment_id', v_payment_id,
    'journal_entry_id', v_je_id,
    'journal_entry_number', v_je_number,
    'receipt_number', _receipt_number,
    'amount_applied', v_applied_to_invoice,
    'overpayment_amount', v_overpayment,
    'new_status', v_new_status,
    'new_amount_paid', v_new_amount_paid,
    'credit_note_id', v_credit_note_id,
    'credit_note_number', v_cn_number
  );

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_payment_atomic(
  _org_id uuid,
  _invoice_id uuid,
  _contact_id uuid,
  _amount numeric,
  _payment_date date,
  _payment_method payment_method_enum,
  _receipt_number text DEFAULT NULL::text,
  _business_id text DEFAULT NULL::text,
  _customer_credit_account_id uuid DEFAULT NULL::uuid,
  _deposit_account_id uuid DEFAULT NULL::uuid
)
RETURNS json
LANGUAGE plpgsql
AS $function$
DECLARE
  v_invoice_number TEXT;
  v_invoice_amount NUMERIC;
  v_amount_due NUMERIC;
  v_overpayment NUMERIC := 0;
  v_credit_note_id UUID;
  v_credit_note_number TEXT;
  v_jentry_id UUID;
  v_jentry_number TEXT;
  v_currency TEXT;
  v_accounts_receivable_id UUID;
  v_amount_paid_previously NUMERIC;
  v_credit_note_seq INT;
  v_payment_id UUID;
BEGIN
  SELECT invoice_number, total, COALESCE(amount_paid, 0)
  INTO v_invoice_number, v_invoice_amount, v_amount_paid_previously
  FROM invoices
  WHERE id = _invoice_id AND organization_id = _org_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', _invoice_id;
  END IF;

  v_amount_due := v_invoice_amount - v_amount_paid_previously;

  IF _amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be greater than 0';
  END IF;

  IF _amount > v_amount_due THEN
    v_overpayment := _amount - v_amount_due;
  END IF;

  SELECT id INTO v_accounts_receivable_id
  FROM accounts
  WHERE organization_id = _org_id
    AND account_type = 'asset'
    AND code = 'AR001'
  LIMIT 1;

  IF v_accounts_receivable_id IS NULL THEN
    RAISE EXCEPTION 'Accounts Receivable (AR001) account not found for organization %', _org_id;
  END IF;

  IF v_overpayment > 0 AND _customer_credit_account_id IS NULL THEN
    RAISE EXCEPTION 'Customer credit account not configured. Cannot process overpayment of %. Please configure the Customer Deposits & Advances account in Finance Settings.', v_overpayment;
  END IF;

  SELECT COALESCE(base_currency, 'USD') INTO v_currency FROM organizations WHERE id = _org_id;

  SELECT generate_next_je_number(_org_id) INTO v_jentry_number;

  v_jentry_id := gen_random_uuid();
  INSERT INTO journal_entries (
    id, organization_id, entry_number, entry_date,
    source_type, source_id, status
  )
  VALUES (
    v_jentry_id, _org_id, v_jentry_number, _payment_date,
    'payment', _invoice_id, 'posted'
  );

  INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, created_at)
  VALUES (gen_random_uuid(), v_jentry_id, _deposit_account_id, _amount, 0, NOW());

  INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, created_at)
  VALUES (gen_random_uuid(), v_jentry_id, v_accounts_receivable_id, 0, _amount, NOW());

  v_payment_id := gen_random_uuid();
  INSERT INTO payments (
    id, organization_id, invoice_id, contact_id, amount,
    payment_date, payment_method, receipt_number, business_id,
    journal_entry_id, status, deposit_account_id
  )
  VALUES (
    v_payment_id, _org_id, _invoice_id, _contact_id, _amount,
    _payment_date, _payment_method, _receipt_number, _business_id,
    v_jentry_id, 'completed', _deposit_account_id
  );

  IF v_overpayment > 0 THEN
    SELECT COALESCE(MAX(CAST(SUBSTRING(credit_note_number FROM POSITION('_' IN credit_note_number) + 1) AS INT)), 0) + 1
    INTO v_credit_note_seq
    FROM credit_notes
    WHERE organization_id = _org_id AND credit_note_number LIKE 'CN_%';

    v_credit_note_number := 'CN_' || v_credit_note_seq::TEXT;

    v_credit_note_id := gen_random_uuid();
    INSERT INTO credit_notes (
      id, organization_id, contact_id, invoice_id,
      credit_note_number, status, issue_date,
      subtotal, tax_amount, total, currency, reason
    )
    VALUES (
      v_credit_note_id, _org_id, _contact_id, _invoice_id,
      v_credit_note_number, 'issued', _payment_date,
      v_overpayment, 0, v_overpayment, v_currency,
      'Overpayment from Payment: ' || v_invoice_number
    );

    INSERT INTO credit_note_applications (
      id, credit_note_id, invoice_id, amount, applied_at, applied_by
    )
    VALUES (
      gen_random_uuid(), v_credit_note_id, _invoice_id, v_overpayment, NOW(), 'system'
    );

    UPDATE credit_notes
    SET amount_applied = v_overpayment
    WHERE id = v_credit_note_id;
  END IF;

  UPDATE invoices
  SET amount_paid = v_amount_paid_previously + LEAST(_amount, v_amount_due),
      status = CASE
        WHEN (v_amount_paid_previously + LEAST(_amount, v_amount_due)) >= v_invoice_amount THEN 'paid'::invoice_status
        WHEN (v_amount_paid_previously + LEAST(_amount, v_amount_due)) > 0 THEN 'partial'::invoice_status
        ELSE status
      END,
      updated_at = NOW()
  WHERE id = _invoice_id;

  RETURN json_build_object(
    'success', true,
    'payment_id', v_payment_id,
    'journal_entry_id', v_jentry_id,
    'journal_entry_number', v_jentry_number,
    'amount_applied', LEAST(_amount, v_amount_due),
    'overpayment_amount', v_overpayment,
    'credit_note_id', v_credit_note_id,
    'credit_note_number', v_credit_note_number,
    'message', 'Payment recorded successfully'
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object(
    'success', false,
    'error', SQLERRM,
    'error_detail', SQLSTATE,
    'invoice_id', _invoice_id
  );
END;
$function$;
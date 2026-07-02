
-- 1. Add deposit_account_id to payments table
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS deposit_account_id UUID REFERENCES public.accounts(id);

-- 2. Create payment_allocations table
CREATE TABLE IF NOT EXISTS public.payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES public.invoices(id),
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.payment_allocations ENABLE ROW LEVEL SECURITY;

-- RLS policies for payment_allocations (same org-check pattern as payments)
CREATE POLICY "payment_allocations_select" ON public.payment_allocations
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM payments p WHERE p.id = payment_id AND user_has_module_permission(auth.uid(), p.organization_id, 'sales', 'read'))
  );

CREATE POLICY "payment_allocations_insert" ON public.payment_allocations
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM payments p WHERE p.id = payment_id AND user_has_module_permission(auth.uid(), p.organization_id, 'sales', 'write'))
  );

CREATE POLICY "payment_allocations_delete" ON public.payment_allocations
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM payments p WHERE p.id = payment_id AND user_has_module_permission(auth.uid(), p.organization_id, 'sales', 'delete'))
  );

-- 3. Drop the old overloads of record_payment_atomic (both signatures)
DROP FUNCTION IF EXISTS public.record_payment_atomic(uuid, uuid, uuid, uuid, numeric, date, text, text, text, text, uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.record_payment_atomic(uuid, uuid, uuid, uuid, numeric, date, text, text, text, text, uuid, uuid, uuid, text, uuid);

-- 4. Create updated record_payment_atomic with mandatory deposit_account_id
CREATE OR REPLACE FUNCTION public.record_payment_atomic(
  _org_id uuid,
  _business_id uuid,
  _invoice_id uuid,
  _contact_id uuid,
  _amount numeric,
  _payment_date date,
  _payment_method text DEFAULT 'bank_transfer',
  _reference text DEFAULT NULL,
  _notes text DEFAULT NULL,
  _receipt_number text DEFAULT NULL,
  _created_by uuid DEFAULT NULL,
  _deposit_account_id uuid DEFAULT NULL,
  _receivable_account_id uuid DEFAULT NULL,
  _je_entry_number text DEFAULT NULL,
  _customer_credit_account_id uuid DEFAULT NULL
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
  v_currency TEXT := 'USD';
BEGIN
  -- MANDATORY: deposit and receivable accounts must be provided
  IF _deposit_account_id IS NULL THEN
    RAISE EXCEPTION 'Deposit account is required. Cannot record payment without a valid GL deposit account.';
  END IF;
  IF _receivable_account_id IS NULL THEN
    RAISE EXCEPTION 'Accounts Receivable account is required. Cannot record payment without a valid AR account.';
  END IF;

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

  -- Guardrail: Prevent overpayment without configured customer credit account
  IF v_overpayment > 0 AND _customer_credit_account_id IS NULL THEN
    RAISE EXCEPTION 'Customer credit account not configured. Cannot process overpayment of %. Please configure the Customer Deposits & Advances account in Finance Settings.', v_overpayment;
  END IF;

  -- Get org currency
  SELECT COALESCE(currency, 'USD') INTO v_currency FROM organizations WHERE id = _org_id;

  -- Insert payment record with deposit_account_id
  INSERT INTO payments (
    organization_id, business_id, invoice_id, contact_id, amount,
    payment_date, payment_method, reference, notes, receipt_number, created_by,
    deposit_account_id
  ) VALUES (
    _org_id, _business_id, _invoice_id, _contact_id, _amount,
    _payment_date, _payment_method::payment_method, _reference, _notes, _receipt_number, _created_by,
    _deposit_account_id
  ) RETURNING id INTO v_payment_id;

  -- Calculate new invoice status
  v_new_amount_paid := COALESCE(v_invoice.amount_paid, 0) + v_applied_to_invoice;
  IF v_new_amount_paid >= v_invoice.total THEN
    v_new_status := 'paid';
  ELSE
    v_new_status := 'partial';
  END IF;

  -- Create journal entry (MANDATORY — no conditional)
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

  -- Dr Deposit Account (full amount received)
  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
  VALUES (v_je_id, _deposit_account_id, _amount, 0, 'Payment received - ' || v_invoice.invoice_number);

  -- Cr Accounts Receivable (amount applied to invoice)
  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
  VALUES (v_je_id, _receivable_account_id, 0, v_applied_to_invoice, 'AR reduction - ' || v_invoice.invoice_number);

  -- Cr Customer Credit (overpayment portion)
  IF v_overpayment > 0 THEN
    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
    VALUES (v_je_id, _customer_credit_account_id, 0, v_overpayment, 'Customer overpayment credit - ' || v_invoice.invoice_number);
  END IF;

  UPDATE payments SET journal_entry_id = v_je_id WHERE id = v_payment_id;

  -- Update invoice
  UPDATE invoices
     SET amount_paid = v_new_amount_paid,
         status = v_new_status::invoice_status
   WHERE id = _invoice_id;

  -- Create overpayment credit note
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
      v_currency,
      'Overpayment on invoice ' || v_invoice.invoice_number,
      'Auto-created from overpayment. Receipt: ' || COALESCE(_receipt_number, 'N/A'),
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

-- 5. Update record_advance_payment to use deposit_account_id and mandate JE
DROP FUNCTION IF EXISTS public.record_advance_payment(uuid, uuid, uuid, numeric, date, text, text, text, text, uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.record_advance_payment(
  _org_id uuid,
  _business_id uuid,
  _contact_id uuid,
  _amount numeric,
  _payment_date date,
  _payment_method text DEFAULT 'bank_transfer',
  _reference text DEFAULT NULL,
  _notes text DEFAULT NULL,
  _receipt_number text DEFAULT NULL,
  _created_by uuid DEFAULT NULL,
  _deposit_account_id uuid DEFAULT NULL,
  _advance_liability_account_id uuid DEFAULT NULL
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
  IF _deposit_account_id IS NULL THEN
    RAISE EXCEPTION 'Deposit account is required for advance payment.';
  END IF;
  IF _advance_liability_account_id IS NULL THEN
    RAISE EXCEPTION 'Customer advance liability account is required.';
  END IF;

  SELECT name INTO v_contact_name FROM contacts WHERE id = _contact_id AND organization_id = _org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contact not found';
  END IF;

  SELECT COALESCE(currency, 'USD') INTO v_currency FROM organizations WHERE id = _org_id;

  -- Insert payment record with deposit_account_id
  INSERT INTO payments (
    organization_id, business_id, invoice_id, contact_id, amount,
    payment_date, payment_method, reference, notes, receipt_number, created_by,
    deposit_account_id
  ) VALUES (
    _org_id, _business_id, NULL, _contact_id, _amount,
    _payment_date, _payment_method::payment_method, _reference, _notes, _receipt_number, _created_by,
    _deposit_account_id
  ) RETURNING id INTO v_payment_id;

  -- Create journal entry (MANDATORY)
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
  VALUES (v_je_id, _deposit_account_id, _amount, 0, 'Advance payment from ' || v_contact_name);

  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
  VALUES (v_je_id, _advance_liability_account_id, 0, _amount, 'Customer advance liability - ' || v_contact_name);

  UPDATE payments SET journal_entry_id = v_je_id WHERE id = v_payment_id;

  -- Auto-create credit note
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

-- 6. Create multi-invoice payment RPC
CREATE OR REPLACE FUNCTION public.record_multi_invoice_payment(
  _org_id uuid,
  _business_id uuid,
  _contact_id uuid,
  _allocations jsonb,
  _total_amount numeric,
  _payment_date date,
  _payment_method text DEFAULT 'bank_transfer',
  _reference text DEFAULT NULL,
  _notes text DEFAULT NULL,
  _receipt_number text DEFAULT NULL,
  _created_by uuid DEFAULT NULL,
  _deposit_account_id uuid DEFAULT NULL,
  _receivable_account_id uuid DEFAULT NULL,
  _customer_credit_account_id uuid DEFAULT NULL
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
  -- Validate mandatory accounts
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

  SELECT COALESCE(currency, 'USD') INTO v_currency FROM organizations WHERE id = _org_id;

  -- Insert ONE payment header with deposit_account_id
  INSERT INTO payments (
    organization_id, business_id, invoice_id, contact_id, amount,
    payment_date, payment_method, reference, notes, receipt_number, created_by,
    deposit_account_id
  ) VALUES (
    _org_id, _business_id, NULL, _contact_id, _total_amount,
    _payment_date, _payment_method::payment_method, _reference, _notes, _receipt_number, _created_by,
    _deposit_account_id
  ) RETURNING id INTO v_payment_id;

  -- Process each allocation
  FOR v_alloc IN SELECT * FROM jsonb_to_recordset(_allocations) AS x(invoice_id uuid, amount numeric)
  LOOP
    IF v_alloc.amount <= 0 THEN
      CONTINUE;
    END IF;

    -- Lock invoice
    SELECT id, invoice_number, total, amount_paid
      INTO v_invoice
      FROM invoices
     WHERE id = v_alloc.invoice_id AND organization_id = _org_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invoice % not found', v_alloc.invoice_id;
    END IF;

    -- Insert allocation row
    INSERT INTO payment_allocations (payment_id, invoice_id, amount)
    VALUES (v_payment_id, v_alloc.invoice_id, v_alloc.amount);

    -- Update invoice
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

  -- Calculate excess (unallocated amount)
  v_excess := _total_amount - v_sum_allocated;

  IF v_excess > 0 AND _customer_credit_account_id IS NULL THEN
    RAISE EXCEPTION 'Customer credit account not configured. Cannot process excess amount of %.', v_excess;
  END IF;

  -- Create ONE journal entry
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
        RAISE EXCEPTION 'Could not generate unique JE number after % retries', v_max_retries;
      END IF;
    END;
  END LOOP;

  -- Dr Deposit Account (total)
  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
  VALUES (v_je_id, _deposit_account_id, _total_amount, 0, 'Payment received from ' || v_contact_name);

  -- Cr AR (sum allocated)
  IF v_sum_allocated > 0 THEN
    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
    VALUES (v_je_id, _receivable_account_id, 0, v_sum_allocated, 'AR reduction - ' || v_contact_name);
  END IF;

  -- Cr Customer Deposits (excess)
  IF v_excess > 0 THEN
    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
    VALUES (v_je_id, _customer_credit_account_id, 0, v_excess, 'Customer credit - excess payment from ' || v_contact_name);

    -- Auto-create credit note for excess
    v_cn_number := get_next_credit_note_number(_org_id);

    INSERT INTO credit_notes (
      organization_id, business_id, contact_id, invoice_id,
      credit_note_number, status, issue_date,
      subtotal, tax_amount, total, amount_applied,
      currency, reason, notes, created_by
    ) VALUES (
      _org_id, _business_id, _contact_id, NULL,
      v_cn_number, 'issued'::credit_note_status, _payment_date,
      v_excess, 0, v_excess, 0,
      v_currency,
      'Excess payment from ' || v_contact_name,
      'Auto-created from multi-invoice payment. Receipt: ' || COALESCE(_receipt_number, 'N/A'),
      _created_by
    ) RETURNING id INTO v_credit_note_id;
  END IF;

  UPDATE payments SET journal_entry_id = v_je_id WHERE id = v_payment_id;

  RETURN jsonb_build_object(
    'payment_id', v_payment_id,
    'journal_entry_id', v_je_id,
    'receipt_number', _receipt_number,
    'total_allocated', v_sum_allocated,
    'excess_amount', v_excess,
    'credit_note_id', v_credit_note_id,
    'invoice_statuses', v_invoice_statuses
  );
END;
$function$;

-- 7. Backfill existing payments: infer deposit_account_id from journal entry debit lines
UPDATE payments p
SET deposit_account_id = sub.account_id
FROM (
  SELECT DISTINCT ON (jel.journal_entry_id)
    jel.journal_entry_id,
    jel.account_id
  FROM journal_entry_lines jel
  WHERE jel.debit > 0
  ORDER BY jel.journal_entry_id, jel.debit DESC
) sub
WHERE p.journal_entry_id = sub.journal_entry_id
  AND p.deposit_account_id IS NULL;

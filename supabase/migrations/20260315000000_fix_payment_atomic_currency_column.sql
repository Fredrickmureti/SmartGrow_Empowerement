-- Migration: Fix payment recording 'column currency does not exist' error
-- Issue: RPC record_payment_atomic references non-existent 'currency' column
-- Solution: Change to 'base_currency' which is the correct column in organizations table
-- Date: March 15, 2026

-- Create enum type if it doesn't exist
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_method_enum') THEN
    CREATE TYPE payment_method_enum AS ENUM ('cash', 'check', 'bank_transfer', 'credit_card', 'mobile_money', 'other');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.record_payment_atomic(
  _org_id UUID,
  _invoice_id UUID,
  _contact_id UUID,
  _amount NUMERIC,
  _payment_date DATE,
  _payment_method payment_method_enum,
  _receipt_number TEXT DEFAULT NULL,
  _business_id TEXT DEFAULT NULL,
  _customer_credit_account_id UUID DEFAULT NULL,
  _deposit_account_id UUID DEFAULT NULL
)
RETURNS JSON AS $$
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
  -- Fetch invoice details
  SELECT invoice_number, total, COALESCE(amount_paid, 0)
  INTO v_invoice_number, v_invoice_amount, v_amount_paid_previously
  FROM invoices
  WHERE id = _invoice_id AND organization_id = _org_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', _invoice_id;
  END IF;

  -- Calculate amount due
  v_amount_due := v_invoice_amount - v_amount_paid_previously;

  -- Validate payment amount
  IF _amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be greater than 0';
  END IF;

  -- Check for overpayment
  IF _amount > v_amount_due THEN
    v_overpayment := _amount - v_amount_due;
  END IF;

  -- Get Accounts Receivable account for GL posting
  SELECT id INTO v_accounts_receivable_id
  FROM accounts
  WHERE organization_id = _org_id
    AND account_type = 'asset'
    AND code = 'AR001'
  LIMIT 1;

  IF v_accounts_receivable_id IS NULL THEN
    RAISE EXCEPTION 'Accounts Receivable (AR001) account not found for organization %', _org_id;
  END IF;

  -- Guardrail: Prevent overpayment without configured customer credit account
  IF v_overpayment > 0 AND _customer_credit_account_id IS NULL THEN
    RAISE EXCEPTION 'Customer credit account not configured. Cannot process overpayment of %. Please configure the Customer Deposits & Advances account in Finance Settings.', v_overpayment;
  END IF;

  -- Get org currency - FIXED: Use base_currency instead of non-existent currency column
  SELECT COALESCE(base_currency, 'USD') INTO v_currency FROM organizations WHERE id = _org_id;

  -- Generate journal entry number first
  SELECT generate_next_je_number(_org_id) INTO v_jentry_number;

  -- Create journal entry
  v_jentry_id := gen_random_uuid();
  INSERT INTO journal_entries (
    id, organization_id, entry_number, entry_date,
    source_type, source_id, status
  )
  VALUES (
    v_jentry_id, _org_id, v_jentry_number, _payment_date,
    'payment', _invoice_id, 'posted'
  );

  -- Post GL journal entry lines
  -- Debit: Cash/Bank (deposit account)
  INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, created_at)
  VALUES (gen_random_uuid(), v_jentry_id, _deposit_account_id, _amount, 0, NOW());

  -- Credit: Accounts Receivable
  INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, created_at)
  VALUES (gen_random_uuid(), v_jentry_id, v_accounts_receivable_id, 0, _amount, NOW());

  -- Insert payment record
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

  -- Handle overpayment: Create credit note
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

    -- Record credit note auto-application
    INSERT INTO credit_note_applications (
      id, credit_note_id, invoice_id, amount, applied_at, applied_by
    )
    VALUES (
      gen_random_uuid(), v_credit_note_id, _invoice_id, v_overpayment, NOW(), 'system'
    );

    -- Update credit notes total applied
    UPDATE credit_notes
    SET amount_applied = v_overpayment
    WHERE id = v_credit_note_id;
  END IF;

  -- Update invoice: Set amount_paid and status
  UPDATE invoices
  SET amount_paid = v_amount_paid_previously + LEAST(_amount, v_amount_due),
      status = CASE
        WHEN (v_amount_paid_previously + LEAST(_amount, v_amount_due)) >= v_invoice_amount THEN 'paid'::invoice_status
        WHEN (v_amount_paid_previously + LEAST(_amount, v_amount_due)) > 0 THEN 'partially_paid'::invoice_status
        ELSE status
      END,
      updated_at = NOW()
  WHERE id = _invoice_id;

  -- Return success with payment and journal entry details
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
$$ LANGUAGE plpgsql SECURITY INVOKER;

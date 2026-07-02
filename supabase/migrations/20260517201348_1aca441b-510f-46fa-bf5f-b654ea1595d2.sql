
-- ─────────────────────────────────────────────────────────────────────
-- 1. Idempotency: a receipt_number can never produce two payment rows.
-- ─────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS payments_org_receipt_number_uq
  ON public.payments (organization_id, receipt_number)
  WHERE receipt_number IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Backfill: every payment with invoice_id but no allocation row gets
--    an allocation equal to min(payment.amount, invoice balance covered).
--    We use payment.amount clamped to the invoice total — this mirrors
--    historical AR settlement (overpayment, if any, stays as the gap
--    between payments.amount and the allocation sum, which the receipt
--    renderer now surfaces correctly as "Unapplied advance").
-- ─────────────────────────────────────────────────────────────────────
INSERT INTO public.payment_allocations (payment_id, invoice_id, amount, branch_id)
SELECT
  p.id,
  p.invoice_id,
  LEAST(p.amount, COALESCE(i.total, p.amount)),
  i.branch_id
FROM public.payments p
JOIN public.invoices i ON i.id = p.invoice_id
WHERE p.invoice_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.payment_allocations a WHERE a.payment_id = p.id
  );

-- ─────────────────────────────────────────────────────────────────────
-- 3. record_payment_atomic v2:
--    - inserts payment_allocations row for the applied portion
--    - idempotent on (organization_id, receipt_number)
--    - asserts sum(allocations) + overpayment = payments.amount
-- ─────────────────────────────────────────────────────────────────────
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
  v_currency TEXT;
  v_effective_business_id UUID;
  v_existing_payment RECORD;
  v_alloc_sum NUMERIC;
BEGIN
  IF _deposit_account_id IS NULL THEN
    RAISE EXCEPTION 'Deposit account is required. Cannot record payment without a valid GL deposit account.';
  END IF;
  IF _receivable_account_id IS NULL THEN
    RAISE EXCEPTION 'Accounts Receivable account is required. Cannot record payment without a valid AR account.';
  END IF;

  -- Idempotency short-circuit: same org + receipt_number → return prior result.
  IF _receipt_number IS NOT NULL THEN
    SELECT id, invoice_id, amount
      INTO v_existing_payment
      FROM payments
     WHERE organization_id = _org_id
       AND receipt_number = _receipt_number
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'payment_id', v_existing_payment.id,
        'applied_amount', v_existing_payment.amount,
        'overpayment', 0,
        'new_status', (SELECT status FROM invoices WHERE id = v_existing_payment.invoice_id),
        'business_id', _business_id,
        'idempotent_replay', true
      );
    END IF;
  END IF;

  SELECT id, invoice_number, total, amount_paid, status, currency, business_id, branch_id
    INTO v_invoice
    FROM invoices
   WHERE id = _invoice_id
     AND organization_id = _org_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  v_effective_business_id := COALESCE(v_invoice.business_id, _business_id);
  IF v_effective_business_id IS NULL THEN
    RAISE EXCEPTION 'business_id is required for payment posting (invoice % has no business and none was supplied)', v_invoice.invoice_number
      USING ERRCODE = '22023';
  END IF;
  IF v_invoice.business_id IS NOT NULL
     AND _business_id IS NOT NULL
     AND v_invoice.business_id <> _business_id THEN
    RAISE EXCEPTION 'Cannot record payment: invoice % belongs to a different company than the active session', v_invoice.invoice_number
      USING ERRCODE = '42501';
  END IF;

  v_currency := COALESCE(
    NULLIF(v_invoice.currency, ''),
    (SELECT base_currency FROM businesses WHERE id = v_effective_business_id),
    'USD'
  );

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

  INSERT INTO payments (
    organization_id, business_id, invoice_id, contact_id, amount,
    payment_date, payment_method, reference, notes, receipt_number, created_by,
    deposit_account_id
  ) VALUES (
    _org_id, v_effective_business_id, _invoice_id, _contact_id, _amount,
    _payment_date, _payment_method::payment_method, _reference, _notes, _receipt_number, _created_by,
    _deposit_account_id
  ) RETURNING id INTO v_payment_id;

  -- Single source of truth: every applied portion gets an allocation row.
  IF v_applied_to_invoice > 0 THEN
    INSERT INTO payment_allocations (payment_id, invoice_id, amount, branch_id)
    VALUES (v_payment_id, _invoice_id, v_applied_to_invoice, v_invoice.branch_id);
  END IF;

  v_new_amount_paid := COALESCE(v_invoice.amount_paid, 0) + v_applied_to_invoice;
  IF v_new_amount_paid >= v_invoice.total THEN
    v_new_status := 'paid'::invoice_status;
  ELSE
    v_new_status := 'partial'::invoice_status;
  END IF;

  LOOP
    BEGIN
      v_je_number := generate_next_je_number(_org_id, v_effective_business_id);

      INSERT INTO journal_entries (
        organization_id, business_id, branch_id, entry_number, entry_date,
        reference, description, source_type, source_id, status, created_by
      ) VALUES (
        _org_id, v_effective_business_id, v_invoice.branch_id, v_je_number,
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

  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description, business_id, branch_id)
  VALUES (v_je_id, _deposit_account_id, _amount, 0,
    'Payment received - ' || v_invoice.invoice_number, v_effective_business_id, v_invoice.branch_id);

  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description, business_id, branch_id)
  VALUES (v_je_id, _receivable_account_id, 0, v_applied_to_invoice,
    'AR settlement - ' || v_invoice.invoice_number, v_effective_business_id, v_invoice.branch_id);

  IF v_overpayment > 0 THEN
    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description, business_id, branch_id)
    VALUES (v_je_id, _customer_credit_account_id, 0, v_overpayment,
      'Customer credit - overpayment on ' || v_invoice.invoice_number, v_effective_business_id, v_invoice.branch_id);
  END IF;

  UPDATE invoices
     SET amount_paid = v_new_amount_paid,
         status = v_new_status,
         updated_at = now()
   WHERE id = _invoice_id;

  -- Financial integrity invariant: Σ allocations + overpayment = payment.amount
  SELECT COALESCE(SUM(amount), 0) INTO v_alloc_sum
    FROM payment_allocations WHERE payment_id = v_payment_id;
  IF ABS((v_alloc_sum + v_overpayment) - _amount) > 0.005 THEN
    RAISE EXCEPTION 'Payment integrity violation: allocations(%) + overpayment(%) != payment.amount(%)',
      v_alloc_sum, v_overpayment, _amount;
  END IF;

  v_result := jsonb_build_object(
    'payment_id', v_payment_id,
    'journal_entry_id', v_je_id,
    'journal_entry_number', v_je_number,
    'applied_amount', v_applied_to_invoice,
    'overpayment', v_overpayment,
    'overpayment_amount', v_overpayment,
    'new_status', v_new_status,
    'business_id', v_effective_business_id
  );

  RETURN v_result;
END;
$function$;

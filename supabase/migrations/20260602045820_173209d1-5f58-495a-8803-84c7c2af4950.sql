
-- Step 4 (Batch 2): payment_allocations is the only canonical link from a
-- payment to its invoice(s). Stop the single-invoice RPC from populating
-- the legacy payments.invoice_id column. The allocation row inserted
-- below remains the source of truth. The column itself is not yet
-- dropped (ADR 0027 holds the DROP until the UI allowlist is empty).

CREATE OR REPLACE FUNCTION public.record_payment_atomic(
  _org_id uuid, _business_id uuid, _invoice_id uuid, _contact_id uuid,
  _amount numeric, _payment_date date,
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
  v_payment_id uuid;
  v_invoice record;
  v_balance_due numeric;
  v_overpayment numeric := 0;
  v_applied_to_invoice numeric;
  v_new_amount_paid numeric;
  v_new_status invoice_status;
  v_je_id uuid;
  v_je_number text;
  v_currency text;
  v_existing_payment record;
  v_existing_invoice_id uuid;
  v_alloc_sum numeric;
  v_account_ok int;
BEGIN
  IF _org_id IS NULL OR _business_id IS NULL THEN
    RAISE EXCEPTION 'Workspace and company are required for payment posting.';
  END IF;
  IF _amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive.';
  END IF;
  IF _deposit_account_id IS NULL THEN
    RAISE EXCEPTION 'Deposit account is required. Cannot record payment without a valid GL deposit account.';
  END IF;
  IF _receivable_account_id IS NULL THEN
    RAISE EXCEPTION 'Accounts Receivable account is required. Cannot record payment without a valid AR account.';
  END IF;

  IF _receipt_number IS NOT NULL THEN
    SELECT p.id, p.amount, p.journal_entry_id, p.outstanding_amount, p.applied_amount
      INTO v_existing_payment
      FROM payments p
     WHERE p.organization_id = _org_id
       AND p.receipt_number = _receipt_number
     LIMIT 1;
    IF FOUND THEN
      -- Resolve invoice via the canonical allocations table.
      SELECT invoice_id INTO v_existing_invoice_id
        FROM payment_allocations
       WHERE payment_id = v_existing_payment.id
       ORDER BY created_at ASC
       LIMIT 1;
      RETURN jsonb_build_object(
        'payment_id', v_existing_payment.id,
        'journal_entry_id', v_existing_payment.journal_entry_id,
        'applied_amount', v_existing_payment.applied_amount,
        'overpayment', v_existing_payment.outstanding_amount,
        'overpayment_amount', v_existing_payment.outstanding_amount,
        'new_status', (SELECT status FROM invoices WHERE id = v_existing_invoice_id),
        'business_id', _business_id,
        'idempotent_replay', true
      );
    END IF;
  END IF;

  SELECT id, invoice_number, total, COALESCE(amount_paid, 0) AS amount_paid,
         status, currency, business_id, organization_id, branch_id, journal_entry_id, contact_id
    INTO v_invoice
    FROM invoices
   WHERE id = _invoice_id
     AND organization_id = _org_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found.';
  END IF;
  IF v_invoice.business_id IS DISTINCT FROM _business_id THEN
    RAISE EXCEPTION 'Cannot record payment: invoice % belongs to a different company than the active session.', v_invoice.invoice_number
      USING ERRCODE = '42501';
  END IF;
  IF v_invoice.status::text IN ('paid','void','voided','cancelled') THEN
    RAISE EXCEPTION 'Invoice % is already % and cannot receive a payment.', v_invoice.invoice_number, v_invoice.status;
  END IF;
  IF v_invoice.journal_entry_id IS NULL THEN
    RAISE EXCEPTION 'Invoice % has no posted journal entry. Payments can only settle posted invoices.', v_invoice.invoice_number;
  END IF;
  IF _contact_id IS NOT NULL AND v_invoice.contact_id IS DISTINCT FROM _contact_id THEN
    RAISE EXCEPTION 'Payment customer does not match invoice customer.';
  END IF;
  _contact_id := v_invoice.contact_id;

  v_balance_due := v_invoice.total - v_invoice.amount_paid;
  IF v_balance_due <= 0 THEN
    RAISE EXCEPTION 'Invoice % has no outstanding balance.', v_invoice.invoice_number;
  END IF;

  SELECT count(*) INTO v_account_ok
    FROM accounts
   WHERE id = _deposit_account_id
     AND organization_id = _org_id
     AND business_id = _business_id
     AND account_type = 'asset'::account_type
     AND COALESCE(is_header, false) = false;
  IF v_account_ok = 0 THEN
    RAISE EXCEPTION 'Deposit account must be a posting asset account in the active company.';
  END IF;

  SELECT count(*) INTO v_account_ok
    FROM accounts
   WHERE id = _receivable_account_id
     AND organization_id = _org_id
     AND business_id = _business_id
     AND account_type = 'asset'::account_type
     AND COALESCE(is_header, false) = false;
  IF v_account_ok = 0 THEN
    RAISE EXCEPTION 'Accounts Receivable account must be a posting asset account in the active company.';
  END IF;

  IF _amount > v_balance_due THEN
    v_applied_to_invoice := v_balance_due;
    v_overpayment := _amount - v_balance_due;
  ELSE
    v_applied_to_invoice := _amount;
    v_overpayment := 0;
  END IF;

  IF v_overpayment > 0 THEN
    IF _customer_credit_account_id IS NULL THEN
      RAISE EXCEPTION 'Customer Deposits account not configured. Cannot process overpayment of %. Configure Customer Deposits under Finance Settings.', v_overpayment;
    END IF;
    SELECT count(*) INTO v_account_ok
      FROM accounts
     WHERE id = _customer_credit_account_id
       AND organization_id = _org_id
       AND business_id = _business_id
       AND account_type = 'liability'::account_type
       AND COALESCE(is_header, false) = false;
    IF v_account_ok = 0 THEN
      RAISE EXCEPTION 'Customer Deposits account must be a posting liability account in the active company.';
    END IF;
  END IF;

  v_currency := COALESCE(NULLIF(v_invoice.currency, ''), (SELECT base_currency FROM businesses WHERE id = _business_id), 'USD');

  -- NOTE: invoice_id is intentionally NULL. The canonical link is the
  -- payment_allocations row inserted below. ADR 0027.
  INSERT INTO payments (
    organization_id, business_id, branch_id, invoice_id, contact_id, amount,
    outstanding_amount, applied_amount,
    payment_date, payment_method, reference, notes, receipt_number, created_by,
    deposit_account_id
  ) VALUES (
    _org_id, _business_id, v_invoice.branch_id, NULL, _contact_id, _amount,
    v_overpayment, v_applied_to_invoice,
    _payment_date, _payment_method::payment_method, _reference, _notes, _receipt_number, _created_by,
    _deposit_account_id
  ) RETURNING id INTO v_payment_id;

  INSERT INTO payment_allocations (payment_id, invoice_id, amount, branch_id)
  VALUES (v_payment_id, _invoice_id, v_applied_to_invoice, v_invoice.branch_id);

  v_new_amount_paid := v_invoice.amount_paid + v_applied_to_invoice;
  IF v_new_amount_paid >= v_invoice.total - 0.000001 THEN
    v_new_status := 'paid'::invoice_status;
  ELSE
    v_new_status := 'partial'::invoice_status;
  END IF;

  v_je_number := COALESCE(_je_entry_number, generate_next_je_number(_org_id, _business_id));
  v_je_id := post_journal_entry_atomic(
    _org_id,
    _business_id,
    v_je_number,
    _payment_date,
    'PMT-' || COALESCE(_receipt_number, v_invoice.invoice_number),
    'Payment for invoice ' || v_invoice.invoice_number,
    'payment',
    v_payment_id,
    _created_by,
    false,
    false,
    CASE WHEN v_overpayment > 0 THEN
      jsonb_build_array(
        jsonb_build_object('account_id', _deposit_account_id, 'debit', _amount, 'credit', 0, 'description', 'Payment received - ' || v_invoice.invoice_number, 'contact_id', _contact_id),
        jsonb_build_object('account_id', _receivable_account_id, 'debit', 0, 'credit', v_applied_to_invoice, 'description', 'AR settlement - ' || v_invoice.invoice_number, 'contact_id', _contact_id),
        jsonb_build_object('account_id', _customer_credit_account_id, 'debit', 0, 'credit', v_overpayment, 'description', 'Customer deposit - overpayment on ' || v_invoice.invoice_number, 'contact_id', _contact_id)
      )
    ELSE
      jsonb_build_array(
        jsonb_build_object('account_id', _deposit_account_id, 'debit', _amount, 'credit', 0, 'description', 'Payment received - ' || v_invoice.invoice_number, 'contact_id', _contact_id),
        jsonb_build_object('account_id', _receivable_account_id, 'debit', 0, 'credit', v_applied_to_invoice, 'description', 'AR settlement - ' || v_invoice.invoice_number, 'contact_id', _contact_id)
      )
    END,
    v_currency,
    NULL,
    NULL,
    v_invoice.branch_id
  );

  UPDATE payments SET journal_entry_id = v_je_id WHERE id = v_payment_id;

  UPDATE invoices
     SET amount_paid = v_new_amount_paid,
         status = v_new_status,
         updated_at = now()
   WHERE id = _invoice_id;

  SELECT COALESCE(SUM(amount), 0) INTO v_alloc_sum
    FROM payment_allocations WHERE payment_id = v_payment_id;
  IF ABS(v_alloc_sum - v_applied_to_invoice) > 0.005 THEN
    RAISE EXCEPTION 'Payment integrity violation: allocations(%) != applied amount(%)', v_alloc_sum, v_applied_to_invoice;
  END IF;
  IF ABS((v_applied_to_invoice + v_overpayment) - _amount) > 0.005 THEN
    RAISE EXCEPTION 'Payment split invariant violation: applied(%) + outstanding(%) != payment.amount(%)', v_applied_to_invoice, v_overpayment, _amount;
  END IF;

  RETURN jsonb_build_object(
    'payment_id', v_payment_id,
    'journal_entry_id', v_je_id,
    'journal_entry_number', v_je_number,
    'applied_amount', v_applied_to_invoice,
    'outstanding_amount', v_overpayment,
    'overpayment', v_overpayment,
    'overpayment_amount', v_overpayment,
    'new_status', v_new_status,
    'business_id', _business_id,
    'credit_note_id', NULL
  );
END;
$function$;

-- Guard: prevent voiding/cancelling an invoice while active (non-reversed)
-- payment allocations still point at it. Operators must reverse the payment
-- (useTransactionReversal.voidPayment / unreconcilePayment) first, which
-- inserts negative compensating allocation rows that net to zero.
CREATE OR REPLACE FUNCTION public.tg_invoices_block_void_with_allocations()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_net_allocated numeric;
  v_invoice_num text;
BEGIN
  IF NEW.status::text NOT IN ('void','voided','cancelled') THEN
    RETURN NEW;
  END IF;
  IF OLD.status::text = NEW.status::text THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM(amount), 0)
    INTO v_net_allocated
    FROM payment_allocations
   WHERE invoice_id = NEW.id;

  IF ABS(v_net_allocated) > 0.005 THEN
    v_invoice_num := COALESCE(NEW.invoice_number, NEW.id::text);
    RAISE EXCEPTION 'Cannot void invoice %: it still has active payment allocations totaling %. Reverse the related payments first.',
      v_invoice_num, v_net_allocated
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_invoices_block_void_with_allocations ON public.invoices;
CREATE TRIGGER trg_invoices_block_void_with_allocations
  BEFORE UPDATE OF status ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_invoices_block_void_with_allocations();

-- 1. Idempotency key columns
ALTER TABLE public.payments      ADD COLUMN IF NOT EXISTS client_request_id text;
ALTER TABLE public.bill_payments ADD COLUMN IF NOT EXISTS client_request_id text;

COMMENT ON COLUMN public.payments.client_request_id IS
  'Caller-supplied idempotency key. Unique per organization. Protects money-in against double submission and webhook replay.';
COMMENT ON COLUMN public.bill_payments.client_request_id IS
  'Caller-supplied idempotency key. Unique per organization. Protects money-out against double submission.';

CREATE UNIQUE INDEX IF NOT EXISTS payments_org_client_request_id_uq
  ON public.payments (organization_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS bill_payments_org_client_request_id_uq
  ON public.bill_payments (organization_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

-- 2. Replace record_multi_invoice_payment with an idempotency-aware version.
--    The old signature is dropped so no ambiguous overload is created.
DROP FUNCTION IF EXISTS public.record_multi_invoice_payment(uuid, uuid, uuid, jsonb, numeric, date, text, text, text, text, uuid, uuid, uuid, uuid, uuid, numeric);

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
  _customer_credit_account_id uuid DEFAULT NULL::uuid,
  _branch_id uuid DEFAULT NULL::uuid,
  _exchange_rate numeric DEFAULT NULL::numeric,
  _request_id text DEFAULT NULL::text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
AS $function$
DECLARE
  v_payment_id uuid;
  v_je_id uuid;
  v_je_number text;
  v_alloc record;
  v_invoice record;
  v_sum_allocated numeric := 0;
  v_excess numeric := 0;
  v_new_amount_paid numeric;
  v_new_status invoice_status;
  v_invoice_statuses jsonb := '[]'::jsonb;
  v_contact_name text;
  v_currency text;
  v_base_currency text;
  v_alloc_count int := 0;
  v_invoice_ids uuid[];
  v_distinct_business int;
  v_distinct_org int;
  v_distinct_contact int;
  v_distinct_currency int;
  v_distinct_nonnull_branch int;
  v_has_null_branch boolean;
  v_resolved_business uuid;
  v_resolved_org uuid;
  v_resolved_contact uuid;
  v_resolved_branch uuid;
  v_account_ok int;
  v_existing_payment record;
  v_lines jsonb;
BEGIN
  IF _total_amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be positive.'; END IF;
  IF _deposit_account_id IS NULL THEN
    RAISE EXCEPTION 'Deposit account is required. Select the GL account that will receive these funds.';
  END IF;
  IF _receivable_account_id IS NULL THEN
    RAISE EXCEPTION 'Accounts Receivable account is not configured. Map it under Settings > Default Accounts.';
  END IF;
  IF _allocations IS NULL OR jsonb_typeof(_allocations) <> 'array' OR jsonb_array_length(_allocations) = 0 THEN
    RAISE EXCEPTION 'No invoices were selected for this payment.';
  END IF;

  -- Idempotency gate 1: explicit caller request key (preferred).
  IF _request_id IS NOT NULL AND _org_id IS NOT NULL THEN
    SELECT p.id, p.journal_entry_id, p.amount, p.outstanding_amount, p.applied_amount
      INTO v_existing_payment
      FROM payments p
     WHERE p.organization_id = _org_id AND p.client_request_id = _request_id
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'payment_id', v_existing_payment.id,
        'journal_entry_id', v_existing_payment.journal_entry_id,
        'allocated', v_existing_payment.applied_amount,
        'applied_amount', v_existing_payment.applied_amount,
        'excess', v_existing_payment.outstanding_amount,
        'excess_amount', v_existing_payment.outstanding_amount,
        'outstanding_amount', v_existing_payment.outstanding_amount,
        'credit_note_id', NULL,
        'invoice_statuses', '[]'::jsonb,
        'idempotent_replay', true
      );
    END IF;
  END IF;

  -- Idempotency gate 2: legacy receipt-number replay guard (back-compat).
  IF _receipt_number IS NOT NULL AND _org_id IS NOT NULL THEN
    SELECT p.id, p.journal_entry_id, p.amount, p.outstanding_amount, p.applied_amount
      INTO v_existing_payment
      FROM payments p
     WHERE p.organization_id = _org_id AND p.receipt_number = _receipt_number
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'payment_id', v_existing_payment.id,
        'journal_entry_id', v_existing_payment.journal_entry_id,
        'allocated', v_existing_payment.applied_amount,
        'excess', v_existing_payment.outstanding_amount,
        'excess_amount', v_existing_payment.outstanding_amount,
        'credit_note_id', NULL,
        'invoice_statuses', '[]'::jsonb,
        'idempotent_replay', true
      );
    END IF;
  END IF;

  SELECT array_agg((x->>'invoice_id')::uuid)
    INTO v_invoice_ids
    FROM jsonb_array_elements(_allocations) AS x
   WHERE COALESCE((x->>'amount')::numeric, 0) > 0;

  IF v_invoice_ids IS NULL OR array_length(v_invoice_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No invoices with a positive allocation amount were provided.';
  END IF;

  PERFORM 1 FROM invoices WHERE id = ANY(v_invoice_ids) FOR UPDATE;

  IF (SELECT count(*) FROM invoices WHERE id = ANY(v_invoice_ids)) <> array_length(v_invoice_ids, 1) THEN
    RAISE EXCEPTION 'One or more selected invoices could not be found. They may have been deleted.';
  END IF;

  SELECT count(DISTINCT business_id), count(DISTINCT organization_id),
         count(DISTINCT contact_id), count(DISTINCT COALESCE(currency, 'USD')),
         count(DISTINCT branch_id), bool_or(branch_id IS NULL)
    INTO v_distinct_business, v_distinct_org, v_distinct_contact, v_distinct_currency,
         v_distinct_nonnull_branch, v_has_null_branch
    FROM invoices WHERE id = ANY(v_invoice_ids);

  IF v_distinct_business > 1 OR v_distinct_org > 1 THEN
    RAISE EXCEPTION 'Selected invoices belong to different companies and cannot be paid together.';
  END IF;
  IF v_distinct_contact > 1 THEN
    RAISE EXCEPTION 'Selected invoices belong to different customers and cannot be paid together.';
  END IF;
  IF v_distinct_currency > 1 THEN
    RAISE EXCEPTION 'Selected invoices use different currencies and cannot be paid together.';
  END IF;
  IF v_distinct_nonnull_branch > 1 OR (v_distinct_nonnull_branch = 1 AND v_has_null_branch) THEN
    RAISE EXCEPTION 'Selected invoices span different branch scopes. Record separate payments per branch/HQ scope.';
  END IF;

  SELECT business_id, organization_id, contact_id, COALESCE(currency, 'USD')
    INTO v_resolved_business, v_resolved_org, v_resolved_contact, v_currency
    FROM invoices WHERE id = ANY(v_invoice_ids) LIMIT 1;

  IF v_distinct_nonnull_branch = 1 THEN
    SELECT DISTINCT branch_id INTO v_resolved_branch
      FROM invoices WHERE id = ANY(v_invoice_ids) AND branch_id IS NOT NULL;
  ELSE
    v_resolved_branch := NULL;
  END IF;

  IF _org_id IS NOT NULL AND _org_id <> v_resolved_org THEN
    RAISE EXCEPTION 'Selected invoices do not belong to the active workspace.';
  END IF;
  IF _business_id IS NOT NULL AND _business_id <> v_resolved_business THEN
    RAISE EXCEPTION 'Selected invoices do not belong to the active company.';
  END IF;
  IF _contact_id IS NOT NULL AND _contact_id <> v_resolved_contact THEN
    RAISE EXCEPTION 'Payment customer does not match selected invoices.';
  END IF;
  IF _branch_id IS NOT NULL AND v_resolved_branch IS NOT NULL AND _branch_id <> v_resolved_branch THEN
    RAISE EXCEPTION 'Selected invoices belong to a different branch than the active branch.';
  END IF;

  _org_id := v_resolved_org;
  _business_id := v_resolved_business;
  _contact_id := v_resolved_contact;
  _branch_id := COALESCE(_branch_id, v_resolved_branch);

  -- FX guardrail: GL is denominated in business base_currency.
  SELECT COALESCE(base_currency, 'USD') INTO v_base_currency
    FROM businesses WHERE id = _business_id;
  IF v_currency <> v_base_currency AND _exchange_rate IS NULL THEN
    RAISE EXCEPTION 'Foreign-currency invoice (% vs base %). An explicit exchange_rate is required to record this payment.',
      v_currency, v_base_currency
      USING ERRCODE = '22023';
  END IF;
  IF _exchange_rate IS NOT NULL AND _exchange_rate <= 0 THEN
    RAISE EXCEPTION 'Exchange rate must be positive.';
  END IF;

  SELECT name INTO v_contact_name
    FROM contacts
   WHERE id = _contact_id AND organization_id = _org_id
     AND (business_id = _business_id OR business_id IS NULL);
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found in the active workspace/company.'; END IF;

  IF _branch_id IS NOT NULL THEN
    PERFORM 1 FROM branches
     WHERE id = _branch_id AND organization_id = _org_id AND business_id = _business_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Selected branch does not belong to the active company.'; END IF;
  END IF;

  SELECT count(*) INTO v_account_ok
    FROM accounts WHERE id = _deposit_account_id
     AND organization_id = _org_id AND business_id = _business_id
     AND account_type = 'asset'::account_type AND COALESCE(is_header, false) = false;
  IF v_account_ok = 0 THEN
    RAISE EXCEPTION 'Deposit account must be a posting asset account in the active company.';
  END IF;

  SELECT count(*) INTO v_account_ok
    FROM accounts WHERE id = _receivable_account_id
     AND organization_id = _org_id AND business_id = _business_id
     AND account_type = 'asset'::account_type AND COALESCE(is_header, false) = false;
  IF v_account_ok = 0 THEN
    RAISE EXCEPTION 'Accounts Receivable account must be a posting asset account in the active company.';
  END IF;

  BEGIN
    INSERT INTO payments (
      organization_id, business_id, branch_id, contact_id, amount,
      outstanding_amount, applied_amount,
      payment_date, payment_method, reference, notes, receipt_number, created_by,
      deposit_account_id, client_request_id
    ) VALUES (
      _org_id, _business_id, _branch_id, _contact_id, _total_amount,
      _total_amount, 0,
      _payment_date, _payment_method::payment_method, _reference, _notes, _receipt_number, _created_by,
      _deposit_account_id, _request_id
    ) RETURNING id INTO v_payment_id;
  EXCEPTION WHEN unique_violation THEN
    -- Concurrent request with the same key won the race: return the winner.
    SELECT p.id, p.journal_entry_id, p.outstanding_amount, p.applied_amount
      INTO v_existing_payment
      FROM payments p
     WHERE p.organization_id = _org_id AND p.client_request_id = _request_id
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'payment_id', v_existing_payment.id,
        'journal_entry_id', v_existing_payment.journal_entry_id,
        'allocated', v_existing_payment.applied_amount,
        'applied_amount', v_existing_payment.applied_amount,
        'excess', v_existing_payment.outstanding_amount,
        'excess_amount', v_existing_payment.outstanding_amount,
        'outstanding_amount', v_existing_payment.outstanding_amount,
        'credit_note_id', NULL,
        'invoice_statuses', '[]'::jsonb,
        'idempotent_replay', true
      );
    END IF;
    RAISE;
  END;

  FOR v_alloc IN
    SELECT (x->>'invoice_id')::uuid AS invoice_id, (x->>'amount')::numeric AS amount
      FROM jsonb_array_elements(_allocations) AS x
  LOOP
    IF v_alloc.amount IS NULL OR v_alloc.amount <= 0 THEN CONTINUE; END IF;

    SELECT id, invoice_number, total, COALESCE(amount_paid, 0) AS amount_paid,
           status, branch_id, journal_entry_id
      INTO v_invoice FROM invoices WHERE id = v_alloc.invoice_id;

    IF v_invoice.status::text IN ('paid','void','voided','cancelled') THEN
      RAISE EXCEPTION 'Invoice % is already % and cannot receive a payment.', v_invoice.invoice_number, v_invoice.status;
    END IF;
    IF v_invoice.journal_entry_id IS NULL THEN
      RAISE EXCEPTION 'Invoice % has no posted journal entry. Payments can only settle posted invoices.', v_invoice.invoice_number;
    END IF;
    IF v_alloc.amount > (v_invoice.total - v_invoice.amount_paid) + 0.000001 THEN
      RAISE EXCEPTION 'Allocation of % to invoice % exceeds its outstanding balance of %.',
        v_alloc.amount, v_invoice.invoice_number, (v_invoice.total - v_invoice.amount_paid);
    END IF;

    INSERT INTO payment_allocations (payment_id, invoice_id, amount, branch_id)
    VALUES (v_payment_id, v_alloc.invoice_id, v_alloc.amount, COALESCE(v_invoice.branch_id, _branch_id));

    v_new_amount_paid := v_invoice.amount_paid + v_alloc.amount;
    IF v_new_amount_paid >= v_invoice.total - 0.000001 THEN
      v_new_status := 'paid'::invoice_status;
    ELSE
      v_new_status := 'partial'::invoice_status;
    END IF;

    UPDATE invoices
       SET amount_paid = v_new_amount_paid, status = v_new_status, updated_at = now()
     WHERE id = v_alloc.invoice_id;

    v_sum_allocated := v_sum_allocated + v_alloc.amount;
    v_alloc_count := v_alloc_count + 1;

    v_invoice_statuses := v_invoice_statuses || jsonb_build_object(
      'invoice_id', v_alloc.invoice_id,
      'new_status', v_new_status,
      'new_amount_paid', v_new_amount_paid
    );
  END LOOP;

  IF v_alloc_count = 0 THEN
    RAISE EXCEPTION 'No invoices with a positive allocation amount were provided.';
  END IF;

  v_excess := _total_amount - v_sum_allocated;
  IF v_excess < -0.000001 THEN
    RAISE EXCEPTION 'Allocation total (%) exceeds payment amount (%).', v_sum_allocated, _total_amount;
  END IF;
  IF v_excess < 0 THEN v_excess := 0; END IF;

  IF v_excess > 0 THEN
    IF _customer_credit_account_id IS NULL THEN
      RAISE EXCEPTION 'Overpayment of % cannot be processed: Customer Deposits account is not configured.', v_excess;
    END IF;
    SELECT count(*) INTO v_account_ok
      FROM accounts WHERE id = _customer_credit_account_id
       AND organization_id = _org_id AND business_id = _business_id
       AND account_type = 'liability'::account_type AND COALESCE(is_header, false) = false;
    IF v_account_ok = 0 THEN
      RAISE EXCEPTION 'Customer Deposits account must be a posting liability account in the active company.';
    END IF;
  END IF;

  UPDATE payments
     SET applied_amount = v_sum_allocated, outstanding_amount = v_excess
   WHERE id = v_payment_id;

  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', _deposit_account_id, 'debit', _total_amount, 'credit', 0,
      'description', 'Payment received from ' || v_contact_name, 'contact_id', _contact_id),
    jsonb_build_object('account_id', _receivable_account_id, 'debit', 0, 'credit', v_sum_allocated,
      'description', 'Allocated to ' || v_alloc_count || ' invoice(s)', 'contact_id', _contact_id)
  );
  IF v_excess > 0 THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', _customer_credit_account_id, 'debit', 0, 'credit', v_excess,
        'description', 'Customer deposit / overpayment', 'contact_id', _contact_id)
    );
  END IF;

  v_je_number := generate_next_je_number(_org_id, _business_id);
  v_je_id := post_journal_entry_atomic(
    _org_id, _business_id,
    v_je_number, _payment_date,
    'PMT-' || COALESCE(_receipt_number, v_payment_id::text),
    'Payment from ' || v_contact_name,
    'payment', v_payment_id, _created_by,
    false, false,
    v_lines, v_currency,
    _exchange_rate,
    NULL, _branch_id
  );

  UPDATE payments SET journal_entry_id = v_je_id WHERE id = v_payment_id;

  RETURN jsonb_build_object(
    'payment_id', v_payment_id,
    'journal_entry_id', v_je_id,
    'journal_entry_number', v_je_number,
    'currency', v_currency,
    'exchange_rate', _exchange_rate,
    'allocated', v_sum_allocated,
    'applied_amount', v_sum_allocated,
    'excess', v_excess,
    'excess_amount', v_excess,
    'outstanding_amount', v_excess,
    'credit_note_id', NULL,
    'invoice_statuses', v_invoice_statuses
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.record_multi_invoice_payment(uuid, uuid, uuid, jsonb, numeric, date, text, text, text, text, uuid, uuid, uuid, uuid, uuid, numeric, text) TO authenticated, service_role;
DROP FUNCTION IF EXISTS public.record_advance_payment(uuid, uuid, uuid, numeric, date, text, text, text, text, uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.record_advance_payment(uuid, uuid, uuid, numeric, date, text, text, text, text, uuid, uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.record_advance_payment(
  _org_id uuid,
  _business_id uuid,
  _contact_id uuid,
  _amount numeric,
  _payment_date date,
  _payment_method text DEFAULT 'bank_transfer'::text,
  _reference text DEFAULT NULL,
  _notes text DEFAULT NULL,
  _receipt_number text DEFAULT NULL,
  _created_by uuid DEFAULT NULL,
  _deposit_account_id uuid DEFAULT NULL,
  _advance_liability_account_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_payment_id uuid;
  v_je_id uuid;
  v_je_number text;
  v_contact_name text;
  v_existing_payment record;
  v_account_ok int;
BEGIN
  IF _org_id IS NULL OR _business_id IS NULL THEN
    RAISE EXCEPTION 'Workspace and company are required for advance payment posting.';
  END IF;
  IF _amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive.';
  END IF;
  IF _deposit_account_id IS NULL THEN
    RAISE EXCEPTION 'Deposit account is required for advance payment.';
  END IF;
  IF _advance_liability_account_id IS NULL THEN
    RAISE EXCEPTION 'Customer Deposits account is required for advance payment.';
  END IF;

  IF _receipt_number IS NOT NULL THEN
    SELECT id, journal_entry_id, amount, outstanding_amount, applied_amount
      INTO v_existing_payment
      FROM payments
     WHERE organization_id = _org_id
       AND receipt_number = _receipt_number
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'payment_id', v_existing_payment.id,
        'journal_entry_id', v_existing_payment.journal_entry_id,
        'outstanding_amount', v_existing_payment.outstanding_amount,
        'applied_amount', v_existing_payment.applied_amount,
        'receipt_number', _receipt_number,
        'idempotent_replay', true,
        'credit_note_id', NULL,
        'credit_note_number', NULL
      );
    END IF;
  END IF;

  SELECT name INTO v_contact_name
    FROM contacts
   WHERE id = _contact_id
     AND organization_id = _org_id
     AND (business_id = _business_id OR business_id IS NULL);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found in the active workspace/company.';
  END IF;

  IF _branch_id IS NOT NULL THEN
    PERFORM 1 FROM branches
     WHERE id = _branch_id
       AND organization_id = _org_id
       AND business_id = _business_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Selected branch does not belong to the active company.';
    END IF;
  END IF;

  SELECT count(*) INTO v_account_ok
    FROM accounts
   WHERE id = _deposit_account_id
     AND organization_id = _org_id
     AND business_id = _business_id
     AND account_type = 'asset'::account_type
     AND COALESCE(is_header, false) = false;
  IF v_account_ok = 0 THEN
    RAISE EXCEPTION 'Deposit account must be an active posting asset account in the active company.';
  END IF;

  SELECT count(*) INTO v_account_ok
    FROM accounts
   WHERE id = _advance_liability_account_id
     AND organization_id = _org_id
     AND business_id = _business_id
     AND account_type = 'liability'::account_type
     AND COALESCE(is_header, false) = false;
  IF v_account_ok = 0 THEN
    RAISE EXCEPTION 'Customer Deposits account must be a posting liability account in the active company.';
  END IF;

  INSERT INTO payments (
    organization_id, business_id, branch_id, invoice_id, contact_id, amount,
    outstanding_amount, applied_amount,
    payment_date, payment_method, reference, notes, receipt_number, created_by,
    deposit_account_id
  ) VALUES (
    _org_id, _business_id, _branch_id, NULL, _contact_id, _amount,
    _amount, 0,
    _payment_date, _payment_method::payment_method, _reference, _notes, _receipt_number, _created_by,
    _deposit_account_id
  ) RETURNING id INTO v_payment_id;

  v_je_number := generate_next_je_number(_org_id, _business_id);
  v_je_id := post_journal_entry_atomic(
    _org_id,
    _business_id,
    v_je_number,
    _payment_date,
    'ADV-' || COALESCE(_receipt_number, v_payment_id::text),
    'Advance payment from ' || v_contact_name,
    'payment',
    v_payment_id,
    _created_by,
    false,
    false,
    jsonb_build_array(
      jsonb_build_object('account_id', _deposit_account_id, 'debit', _amount, 'credit', 0, 'description', 'Advance payment from ' || v_contact_name, 'contact_id', _contact_id),
      jsonb_build_object('account_id', _advance_liability_account_id, 'debit', 0, 'credit', _amount, 'description', 'Customer deposit liability - ' || v_contact_name, 'contact_id', _contact_id)
    ),
    NULL,
    NULL,
    'advance',
    _branch_id
  );

  UPDATE payments SET journal_entry_id = v_je_id WHERE id = v_payment_id;

  RETURN jsonb_build_object(
    'payment_id', v_payment_id,
    'journal_entry_id', v_je_id,
    'journal_entry_number', v_je_number,
    'outstanding_amount', _amount,
    'applied_amount', 0,
    'receipt_number', _receipt_number,
    'credit_note_id', NULL,
    'credit_note_number', NULL
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_payment_atomic(
  _org_id uuid,
  _business_id uuid,
  _invoice_id uuid,
  _contact_id uuid,
  _amount numeric,
  _payment_date date,
  _payment_method text DEFAULT 'bank_transfer'::text,
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
    SELECT p.id, p.invoice_id, p.amount, p.journal_entry_id, p.outstanding_amount, p.applied_amount
      INTO v_existing_payment
      FROM payments p
     WHERE p.organization_id = _org_id
       AND p.receipt_number = _receipt_number
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'payment_id', v_existing_payment.id,
        'journal_entry_id', v_existing_payment.journal_entry_id,
        'applied_amount', v_existing_payment.applied_amount,
        'overpayment', v_existing_payment.outstanding_amount,
        'overpayment_amount', v_existing_payment.outstanding_amount,
        'new_status', (SELECT status FROM invoices WHERE id = v_existing_payment.invoice_id),
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

  INSERT INTO payments (
    organization_id, business_id, branch_id, invoice_id, contact_id, amount,
    outstanding_amount, applied_amount,
    payment_date, payment_method, reference, notes, receipt_number, created_by,
    deposit_account_id
  ) VALUES (
    _org_id, _business_id, v_invoice.branch_id, _invoice_id, _contact_id, _amount,
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

CREATE OR REPLACE FUNCTION public.record_multi_invoice_payment(
  _org_id uuid,
  _business_id uuid,
  _contact_id uuid,
  _allocations jsonb,
  _total_amount numeric,
  _payment_date date,
  _payment_method text DEFAULT 'bank_transfer'::text,
  _reference text DEFAULT NULL,
  _notes text DEFAULT NULL,
  _receipt_number text DEFAULT NULL,
  _created_by uuid DEFAULT NULL,
  _deposit_account_id uuid DEFAULT NULL,
  _receivable_account_id uuid DEFAULT NULL,
  _customer_credit_account_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
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
  IF _total_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive.';
  END IF;
  IF _deposit_account_id IS NULL THEN
    RAISE EXCEPTION 'Deposit account is required. Select the GL account that will receive these funds.';
  END IF;
  IF _receivable_account_id IS NULL THEN
    RAISE EXCEPTION 'Accounts Receivable account is not configured. Map it under Settings > Default Accounts.';
  END IF;
  IF _allocations IS NULL OR jsonb_typeof(_allocations) <> 'array' OR jsonb_array_length(_allocations) = 0 THEN
    RAISE EXCEPTION 'No invoices were selected for this payment.';
  END IF;

  IF _receipt_number IS NOT NULL AND _org_id IS NOT NULL THEN
    SELECT p.id, p.journal_entry_id, p.amount, p.outstanding_amount, p.applied_amount
      INTO v_existing_payment
      FROM payments p
     WHERE p.organization_id = _org_id
       AND p.receipt_number = _receipt_number
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
    FROM invoices
   WHERE id = ANY(v_invoice_ids);

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
    FROM invoices
   WHERE id = ANY(v_invoice_ids)
   LIMIT 1;

  IF v_distinct_nonnull_branch = 1 THEN
    SELECT DISTINCT branch_id INTO v_resolved_branch
      FROM invoices
     WHERE id = ANY(v_invoice_ids)
       AND branch_id IS NOT NULL;
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

  SELECT name INTO v_contact_name
    FROM contacts
   WHERE id = _contact_id
     AND organization_id = _org_id
     AND (business_id = _business_id OR business_id IS NULL);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found in the active workspace/company.';
  END IF;

  IF _branch_id IS NOT NULL THEN
    PERFORM 1 FROM branches
     WHERE id = _branch_id
       AND organization_id = _org_id
       AND business_id = _business_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Selected branch does not belong to the active company.';
    END IF;
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

  INSERT INTO payments (
    organization_id, business_id, branch_id, invoice_id, contact_id, amount,
    outstanding_amount, applied_amount,
    payment_date, payment_method, reference, notes, receipt_number, created_by,
    deposit_account_id
  ) VALUES (
    _org_id, _business_id, _branch_id, NULL, _contact_id, _total_amount,
    _total_amount, 0,
    _payment_date, _payment_method::payment_method, _reference, _notes, _receipt_number, _created_by,
    _deposit_account_id
  ) RETURNING id INTO v_payment_id;

  FOR v_alloc IN
    SELECT (x->>'invoice_id')::uuid AS invoice_id, (x->>'amount')::numeric AS amount
      FROM jsonb_array_elements(_allocations) AS x
  LOOP
    IF v_alloc.amount IS NULL OR v_alloc.amount <= 0 THEN
      CONTINUE;
    END IF;

    SELECT id, invoice_number, total, COALESCE(amount_paid, 0) AS amount_paid,
           status, branch_id, journal_entry_id
      INTO v_invoice
      FROM invoices
     WHERE id = v_alloc.invoice_id;

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
       SET amount_paid = v_new_amount_paid,
           status = v_new_status,
           updated_at = now()
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
  IF v_excess < 0 THEN
    v_excess := 0;
  END IF;

  IF v_excess > 0 THEN
    IF _customer_credit_account_id IS NULL THEN
      RAISE EXCEPTION 'Overpayment of % cannot be processed: Customer Deposits account is not configured.', v_excess;
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

  UPDATE payments
     SET applied_amount = v_sum_allocated,
         outstanding_amount = v_excess
   WHERE id = v_payment_id;

  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', _deposit_account_id, 'debit', _total_amount, 'credit', 0, 'description', 'Payment received from ' || v_contact_name, 'contact_id', _contact_id),
    jsonb_build_object('account_id', _receivable_account_id, 'debit', 0, 'credit', v_sum_allocated, 'description', 'Allocated to ' || v_alloc_count || ' invoice(s)', 'contact_id', _contact_id)
  );
  IF v_excess > 0 THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', _customer_credit_account_id, 'debit', 0, 'credit', v_excess, 'description', 'Customer deposit / overpayment', 'contact_id', _contact_id)
    );
  END IF;

  v_je_number := generate_next_je_number(_org_id, _business_id);
  v_je_id := post_journal_entry_atomic(
    _org_id,
    _business_id,
    v_je_number,
    _payment_date,
    'PMT-' || COALESCE(_receipt_number, v_payment_id::text),
    'Payment from ' || v_contact_name,
    'payment',
    v_payment_id,
    _created_by,
    false,
    false,
    v_lines,
    v_currency,
    NULL,
    NULL,
    _branch_id
  );

  UPDATE payments SET journal_entry_id = v_je_id WHERE id = v_payment_id;

  RETURN jsonb_build_object(
    'payment_id', v_payment_id,
    'journal_entry_id', v_je_id,
    'journal_entry_number', v_je_number,
    'currency', v_currency,
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
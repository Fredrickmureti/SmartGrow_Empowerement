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
  _branch_id uuid DEFAULT NULL::uuid
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
  v_currency TEXT;
  v_credit_note_id UUID;
  v_cn_number TEXT;
  v_alloc_count INT := 0;
  v_invoice_ids uuid[];
  v_distinct_business INT;
  v_distinct_org INT;
  v_distinct_contact INT;
  v_distinct_currency INT;
  v_resolved_business uuid;
  v_resolved_org uuid;
  v_resolved_branch uuid;
  v_account_ok INT;
BEGIN
  -- Basic argument validation
  IF _deposit_account_id IS NULL THEN
    RAISE EXCEPTION 'Deposit account is required. Select the GL account that will receive these funds.';
  END IF;
  IF _receivable_account_id IS NULL THEN
    RAISE EXCEPTION 'Accounts Receivable account is not configured. Map it under Settings > Default Accounts.';
  END IF;
  IF _total_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive.';
  END IF;
  IF _allocations IS NULL OR jsonb_array_length(_allocations) = 0 THEN
    RAISE EXCEPTION 'No invoices were selected for this payment.';
  END IF;

  -- Collect invoice ids from the allocations payload (positive amounts only)
  SELECT array_agg((x->>'invoice_id')::uuid)
    INTO v_invoice_ids
    FROM jsonb_array_elements(_allocations) AS x
   WHERE COALESCE((x->>'amount')::numeric, 0) > 0;

  IF v_invoice_ids IS NULL OR array_length(v_invoice_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No invoices with a positive allocation amount were provided.';
  END IF;

  -- Lock and inspect every selected invoice in one go
  PERFORM 1
     FROM invoices
    WHERE id = ANY(v_invoice_ids)
    FOR UPDATE;

  -- All invoices must exist
  IF (SELECT count(*) FROM invoices WHERE id = ANY(v_invoice_ids)) <> array_length(v_invoice_ids, 1) THEN
    RAISE EXCEPTION 'One or more selected invoices could not be found. They may have been deleted.';
  END IF;

  -- Multi-company isolation: invoices must share business and organization
  SELECT count(DISTINCT business_id), count(DISTINCT organization_id),
         count(DISTINCT contact_id), count(DISTINCT COALESCE(currency, 'USD'))
    INTO v_distinct_business, v_distinct_org, v_distinct_contact, v_distinct_currency
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

  -- Derive authoritative context from the invoices themselves
  SELECT business_id, organization_id, contact_id, COALESCE(currency, 'USD'),
         CASE WHEN count(DISTINCT branch_id) = 1 THEN max(branch_id) ELSE NULL END
    INTO v_resolved_business, v_resolved_org, _contact_id, v_currency, v_resolved_branch
    FROM invoices
   WHERE id = ANY(v_invoice_ids)
   GROUP BY business_id, organization_id, contact_id, COALESCE(currency, 'USD');

  -- Frontend-supplied context must match (defends against stale UI state)
  IF _org_id IS NOT NULL AND _org_id <> v_resolved_org THEN
    RAISE EXCEPTION 'Selected invoices do not belong to the active workspace.';
  END IF;
  IF _business_id IS NOT NULL AND _business_id <> v_resolved_business THEN
    RAISE EXCEPTION 'Selected invoices do not belong to the active company.';
  END IF;

  -- Caller-provided branch (when set) must match the invoices' shared branch
  IF _branch_id IS NOT NULL AND v_resolved_branch IS NOT NULL AND _branch_id <> v_resolved_branch THEN
    RAISE EXCEPTION 'Selected invoices belong to a different branch than the active branch.';
  END IF;
  IF _branch_id IS NULL THEN
    _branch_id := v_resolved_branch;
  END IF;

  -- Use the authoritative ids from here on
  _org_id := v_resolved_org;
  _business_id := v_resolved_business;

  -- Customer must belong to this company
  SELECT name INTO v_contact_name
    FROM contacts
   WHERE id = _contact_id AND organization_id = _org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found in the active workspace.';
  END IF;

  -- Validate accounts belong to the same (org, business)
  SELECT count(*) INTO v_account_ok
    FROM accounts
   WHERE id = _deposit_account_id
     AND organization_id = _org_id
     AND (business_id = _business_id OR business_id IS NULL);
  IF v_account_ok = 0 THEN
    RAISE EXCEPTION 'Deposit account does not belong to the active company.';
  END IF;

  SELECT count(*) INTO v_account_ok
    FROM accounts
   WHERE id = _receivable_account_id
     AND organization_id = _org_id
     AND (business_id = _business_id OR business_id IS NULL);
  IF v_account_ok = 0 THEN
    RAISE EXCEPTION 'Accounts Receivable account does not belong to the active company.';
  END IF;

  IF _customer_credit_account_id IS NOT NULL THEN
    SELECT count(*) INTO v_account_ok
      FROM accounts
     WHERE id = _customer_credit_account_id
       AND organization_id = _org_id
       AND (business_id = _business_id OR business_id IS NULL);
    IF v_account_ok = 0 THEN
      RAISE EXCEPTION 'Customer credit account does not belong to the active company.';
    END IF;
  END IF;

  -- Create the payment header
  INSERT INTO payments (
    organization_id, business_id, branch_id, invoice_id, contact_id, amount,
    payment_date, payment_method, reference, notes, receipt_number, created_by,
    deposit_account_id
  ) VALUES (
    _org_id, _business_id, _branch_id, NULL, _contact_id, _total_amount,
    _payment_date, _payment_method::payment_method, _reference, _notes, _receipt_number, _created_by,
    _deposit_account_id
  ) RETURNING id INTO v_payment_id;

  -- Walk every allocation, validate against invoice state, write allocation, update invoice
  FOR v_alloc IN
    SELECT (x->>'invoice_id')::uuid AS invoice_id, (x->>'amount')::numeric AS amount
      FROM jsonb_array_elements(_allocations) AS x
  LOOP
    IF v_alloc.amount IS NULL OR v_alloc.amount <= 0 THEN
      CONTINUE;
    END IF;

    SELECT id, invoice_number, total, COALESCE(amount_paid, 0) AS amount_paid, status
      INTO v_invoice
      FROM invoices
     WHERE id = v_alloc.invoice_id;

    IF v_invoice.status::text IN ('paid','void','cancelled') THEN
      RAISE EXCEPTION 'Invoice % is already % and cannot receive a payment.',
        v_invoice.invoice_number, v_invoice.status;
    END IF;

    IF v_alloc.amount > (v_invoice.total - v_invoice.amount_paid) + 0.000001 THEN
      RAISE EXCEPTION 'Allocation of % to invoice % exceeds its outstanding balance of %.',
        v_alloc.amount, v_invoice.invoice_number, (v_invoice.total - v_invoice.amount_paid);
    END IF;

    INSERT INTO payment_allocations (payment_id, invoice_id, amount, branch_id)
    VALUES (v_payment_id, v_alloc.invoice_id, v_alloc.amount, _branch_id);

    v_new_amount_paid := v_invoice.amount_paid + v_alloc.amount;
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

  IF v_excess > 0 AND _customer_credit_account_id IS NULL THEN
    RAISE EXCEPTION 'Overpayment of % cannot be processed: customer credit account is not configured.', v_excess;
  END IF;

  -- Number and post the JE with proper company context
  LOOP
    BEGIN
      v_je_number := generate_next_je_number(_org_id, _business_id);

      INSERT INTO journal_entries (
        organization_id, business_id, branch_id, entry_number, entry_date,
        reference, description, source_type, source_id, status, created_by
      ) VALUES (
        _org_id, _business_id, _branch_id, v_je_number,
        _payment_date, 'PMT-' || COALESCE(_receipt_number, v_payment_id::text),
        'Payment from ' || v_contact_name,
        'payment', v_payment_id, 'posted', _created_by
      ) RETURNING id INTO v_je_id;

      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_retry := v_retry + 1;
      IF v_retry >= v_max_retries THEN
        RAISE EXCEPTION 'Could not assign a unique journal entry number. Please retry.';
      END IF;
    END;
  END LOOP;

  -- Dr deposit account
  INSERT INTO journal_entry_lines (
    journal_entry_id, account_id, debit, credit, description,
    business_id, branch_id
  ) VALUES (
    v_je_id, _deposit_account_id, _total_amount, 0,
    'Payment received from ' || v_contact_name,
    _business_id, _branch_id
  );

  -- Cr Accounts Receivable for the allocated portion
  IF v_sum_allocated > 0 THEN
    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, debit, credit, description,
      business_id, branch_id
    ) VALUES (
      v_je_id, _receivable_account_id, 0, v_sum_allocated,
      'Allocated to ' || v_alloc_count || ' invoice(s)',
      _business_id, _branch_id
    );
  END IF;

  -- Cr customer-credit liability for any excess
  IF v_excess > 0 THEN
    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, debit, credit, description,
      business_id, branch_id
    ) VALUES (
      v_je_id, _customer_credit_account_id, 0, v_excess,
      'Customer advance / overpayment',
      _business_id, _branch_id
    );

    BEGIN
      v_cn_number := 'ADV-' || to_char(now(), 'YYYYMMDDHH24MISS');
      INSERT INTO credit_notes (
        organization_id, business_id, branch_id, contact_id, credit_note_number,
        issue_date, total, status, notes, created_by, currency
      ) VALUES (
        _org_id, _business_id, _branch_id, _contact_id, v_cn_number,
        _payment_date, v_excess, 'draft', 'Auto-created from overpayment', _created_by, v_currency
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
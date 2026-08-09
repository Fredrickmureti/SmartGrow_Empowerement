DROP FUNCTION IF EXISTS public.record_advance_payment(uuid, uuid, uuid, numeric, date, text, text, text, text, uuid, uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.record_advance_payment(
  _org_id uuid,
  _business_id uuid,
  _contact_id uuid,
  _amount numeric,
  _payment_date date,
  _payment_method text,
  _reference text,
  _notes text,
  _receipt_number text,
  _created_by uuid,
  _deposit_account_id uuid,
  _advance_liability_account_id uuid,
  _branch_id uuid,
  _request_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  -- Idempotency gate 1: explicit caller request key (preferred).
  IF _request_id IS NOT NULL THEN
    SELECT id, journal_entry_id, amount, outstanding_amount, applied_amount, receipt_number
      INTO v_existing_payment
      FROM payments
     WHERE organization_id = _org_id
       AND client_request_id = _request_id
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'payment_id', v_existing_payment.id,
        'journal_entry_id', v_existing_payment.journal_entry_id,
        'outstanding_amount', v_existing_payment.outstanding_amount,
        'applied_amount', v_existing_payment.applied_amount,
        'receipt_number', v_existing_payment.receipt_number,
        'idempotent_replay', true,
        'credit_note_id', NULL,
        'credit_note_number', NULL
      );
    END IF;
  END IF;

  -- Idempotency gate 2: receipt number reuse.
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
    organization_id, business_id, branch_id, contact_id, amount,
    outstanding_amount, applied_amount,
    payment_date, payment_method, reference, notes, receipt_number, created_by,
    deposit_account_id, client_request_id
  ) VALUES (
    _org_id, _business_id, _branch_id, _contact_id, _amount,
    _amount, 0,
    _payment_date, _payment_method::payment_method, _reference, _notes, _receipt_number, _created_by,
    _deposit_account_id, _request_id
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
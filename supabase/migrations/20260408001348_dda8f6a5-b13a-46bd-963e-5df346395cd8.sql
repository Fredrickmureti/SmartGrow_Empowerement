
CREATE OR REPLACE FUNCTION public.reconcile_bank_transaction_atomic(
  p_transaction_id UUID,
  p_entity_type TEXT,
  p_entity_id UUID,
  p_organization_id UUID,
  p_user_id UUID,
  p_payment_method TEXT DEFAULT 'bank_transfer',
  p_notes TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_transaction RECORD;
  v_payment_id UUID;
  v_receipt_number TEXT;
  v_contact_id UUID;
  v_result JSON;
BEGIN
  -- Get the transaction
  SELECT * INTO v_transaction
  FROM bank_transactions
  WHERE id = p_transaction_id
    AND organization_id = p_organization_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaction not found';
  END IF;

  IF v_transaction.is_reconciled = true THEN
    RAISE EXCEPTION 'Transaction already reconciled';
  END IF;

  -- Get next receipt number
  SELECT public.get_next_receipt_number(p_organization_id) INTO v_receipt_number;

  IF p_entity_type = 'invoice' THEN
    -- Fetch contact_id from the invoice
    SELECT contact_id INTO v_contact_id
    FROM invoices
    WHERE id = p_entity_id AND organization_id = p_organization_id;

    -- Create payment record with contact_id
    INSERT INTO payments (
      organization_id,
      invoice_id,
      contact_id,
      amount,
      payment_date,
      payment_method,
      receipt_number,
      reference,
      notes,
      created_by
    ) VALUES (
      p_organization_id,
      p_entity_id,
      v_contact_id,
      ABS(v_transaction.amount),
      v_transaction.transaction_date,
      p_payment_method,
      v_receipt_number,
      v_transaction.reference,
      COALESCE(p_notes, 'Bank reconciliation: ' || v_transaction.description),
      p_user_id
    ) RETURNING id INTO v_payment_id;

    -- Update invoice amount_paid and status
    UPDATE invoices
    SET amount_paid = LEAST(amount_paid + ABS(v_transaction.amount), total),
        status = CASE
          WHEN amount_paid + ABS(v_transaction.amount) >= total THEN 'paid'
          WHEN amount_paid + ABS(v_transaction.amount) > 0 THEN 'partial'
          ELSE status
        END,
        updated_at = now()
    WHERE id = p_entity_id AND organization_id = p_organization_id;

  ELSIF p_entity_type = 'bill' THEN
    -- Fetch vendor_id from the bill
    SELECT vendor_id INTO v_contact_id
    FROM bills
    WHERE id = p_entity_id AND organization_id = p_organization_id;

    -- Create bill payment record with vendor_id
    INSERT INTO bill_payments (
      organization_id,
      bill_id,
      amount,
      payment_date,
      payment_method,
      reference,
      notes,
      created_by
    ) VALUES (
      p_organization_id,
      p_entity_id,
      ABS(v_transaction.amount),
      v_transaction.transaction_date,
      p_payment_method,
      v_transaction.reference,
      COALESCE(p_notes, 'Bank reconciliation: ' || v_transaction.description),
      p_user_id
    ) RETURNING id INTO v_payment_id;

    -- Update bill amount_paid and status
    UPDATE bills
    SET amount_paid = LEAST(amount_paid + ABS(v_transaction.amount), total),
        status = CASE
          WHEN amount_paid + ABS(v_transaction.amount) >= total THEN 'paid'
          WHEN amount_paid + ABS(v_transaction.amount) > 0 THEN 'partial'
          ELSE status
        END,
        updated_at = now()
    WHERE id = p_entity_id AND organization_id = p_organization_id;
  ELSE
    RAISE EXCEPTION 'Unsupported entity type: %', p_entity_type;
  END IF;

  -- Mark bank transaction as reconciled
  UPDATE bank_transactions
  SET is_reconciled = true,
      reconciled_at = now(),
      reconciled_by = p_user_id,
      reconciled_type = p_entity_type,
      reconciled_entity_id = p_entity_id,
      reconciled_payment_id = v_payment_id,
      lifecycle_status = 'reconciled',
      updated_at = now()
  WHERE id = p_transaction_id;

  v_result := json_build_object(
    'success', true,
    'payment_id', v_payment_id,
    'receipt_number', v_receipt_number
  );

  RETURN v_result;
END;
$$;

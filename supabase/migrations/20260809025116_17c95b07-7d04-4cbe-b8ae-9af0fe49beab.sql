DROP FUNCTION IF EXISTS public.record_payment_atomic(uuid, uuid, uuid, uuid, numeric, date, text, text, text, text, uuid, uuid, uuid, text, uuid);

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
  _customer_credit_account_id uuid DEFAULT NULL::uuid,
  _request_id text DEFAULT NULL::text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
AS $function$
DECLARE
  v_invoice record;
  v_balance_due numeric;
  v_applied numeric;
  v_result jsonb;
  v_branch_id uuid;
  v_existing record;
BEGIN
  -- DEPRECATED shim: single-invoice settlement is just a one-allocation
  -- multi-invoice payment. All logic lives in record_multi_invoice_payment.
  IF _invoice_id IS NULL THEN
    RAISE EXCEPTION 'Invoice is required. Use record_advance_payment for unapplied receipts.';
  END IF;

  -- Idempotency gate must run before the "no outstanding balance" guard,
  -- otherwise a replay of a fully-settling payment raises instead of
  -- returning the original payment.
  IF _request_id IS NOT NULL AND _org_id IS NOT NULL THEN
    SELECT p.id, p.journal_entry_id, p.applied_amount, p.outstanding_amount
      INTO v_existing
      FROM public.payments p
     WHERE p.organization_id = _org_id AND p.client_request_id = _request_id
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'payment_id', v_existing.id,
        'journal_entry_id', v_existing.journal_entry_id,
        'allocated', v_existing.applied_amount,
        'applied_amount', v_existing.applied_amount,
        'excess', v_existing.outstanding_amount,
        'excess_amount', v_existing.outstanding_amount,
        'overpayment', v_existing.outstanding_amount,
        'overpayment_amount', v_existing.outstanding_amount,
        'outstanding_amount', v_existing.outstanding_amount,
        'invoice_statuses', '[]'::jsonb,
        'new_status', (SELECT status FROM public.invoices WHERE id = _invoice_id),
        'business_id', _business_id,
        'idempotent_replay', true
      );
    END IF;
  END IF;

  SELECT id, invoice_number, total, COALESCE(amount_paid, 0) AS amount_paid,
         status, business_id, contact_id, branch_id
    INTO v_invoice
    FROM invoices
   WHERE id = _invoice_id AND organization_id = _org_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found.';
  END IF;
  IF v_invoice.business_id IS DISTINCT FROM _business_id THEN
    RAISE EXCEPTION 'Cannot record payment: invoice % belongs to a different company than the active session.',
      v_invoice.invoice_number USING ERRCODE = '42501';
  END IF;

  v_balance_due := v_invoice.total - v_invoice.amount_paid;
  IF v_balance_due <= 0 THEN
    RAISE EXCEPTION 'Invoice % has no outstanding balance.', v_invoice.invoice_number;
  END IF;

  v_applied := LEAST(_amount, v_balance_due);
  v_branch_id := v_invoice.branch_id;

  v_result := public.record_multi_invoice_payment(
    _org_id := _org_id,
    _business_id := _business_id,
    _contact_id := COALESCE(_contact_id, v_invoice.contact_id),
    _allocations := jsonb_build_array(
      jsonb_build_object('invoice_id', _invoice_id, 'amount', v_applied)
    ),
    _total_amount := _amount,
    _payment_date := _payment_date,
    _payment_method := _payment_method,
    _reference := _reference,
    _notes := _notes,
    _receipt_number := _receipt_number,
    _created_by := _created_by,
    _deposit_account_id := _deposit_account_id,
    _receivable_account_id := _receivable_account_id,
    _customer_credit_account_id := _customer_credit_account_id,
    _branch_id := v_branch_id,
    _exchange_rate := NULL,
    _request_id := _request_id
  );

  RETURN v_result
    || jsonb_build_object(
         'overpayment', v_result->'excess',
         'overpayment_amount', v_result->'excess',
         'new_status', (SELECT status FROM invoices WHERE id = _invoice_id),
         'business_id', _business_id
       );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.record_payment_atomic(uuid, uuid, uuid, uuid, numeric, date, text, text, text, text, uuid, uuid, uuid, text, uuid, text) TO authenticated, service_role;
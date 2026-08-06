-- ADR 0128 — one writer for POS-originated invoices.
-- Adds a `_mode` argument so the "Invoice this transaction" action (already
-- fully tendered) uses the same routine as an on-account credit sale, instead
-- of a client-side multi-step saga.
DROP FUNCTION IF EXISTS public.create_pos_credit_sale_invoice_atomic(uuid, integer, uuid);

CREATE OR REPLACE FUNCTION public.create_pos_credit_sale_invoice_atomic(
  _pos_transaction_id uuid,
  _due_days integer DEFAULT 30,
  _user_id uuid DEFAULT auth.uid(),
  _mode text DEFAULT 'credit'
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_txn           RECORD;
  v_credit_amount numeric := 0;
  v_total         numeric := 0;
  v_subtotal      numeric := 0;
  v_tax           numeric := 0;
  v_invoice_no    text;
  v_invoice_id    uuid;
  v_currency      text;
  v_status        invoice_status;
  v_mode          text := COALESCE(_mode, 'credit');
BEGIN
  IF _pos_transaction_id IS NULL THEN
    RAISE EXCEPTION 'create_pos_credit_sale_invoice_atomic: _pos_transaction_id is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_mode NOT IN ('credit', 'full') THEN
    RAISE EXCEPTION 'create_pos_credit_sale_invoice_atomic: unknown mode %', v_mode
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Lock the POS transaction: the row is the idempotency anchor.
  SELECT * INTO v_txn
    FROM public.pos_transactions
   WHERE id = _pos_transaction_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_pos_credit_sale_invoice_atomic: pos transaction % not found', _pos_transaction_id
      USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM public._assert_org_member(v_txn.organization_id);

  -- Idempotent: a linked invoice means this work is already done.
  IF v_txn.invoice_id IS NOT NULL THEN
    RETURN v_txn.invoice_id;
  END IF;

  IF v_txn.customer_id IS NULL THEN
    RAISE EXCEPTION 'create_pos_credit_sale_invoice_atomic: transaction % has no customer', _pos_transaction_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_txn.branch_id IS NULL THEN
    RAISE EXCEPTION 'create_pos_credit_sale_invoice_atomic: pos transaction % has no branch context', _pos_transaction_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Amounts are derived server-side from the committed rows, never from a
  -- client-supplied figure.
  SELECT COALESCE(SUM(amount), 0) INTO v_credit_amount
    FROM public.pos_transaction_payments
   WHERE transaction_id = _pos_transaction_id
     AND payment_method = 'credit'
     AND COALESCE(status, 'completed') = 'completed';

  IF v_mode = 'credit' AND v_credit_amount <= 0 THEN
    RAISE EXCEPTION 'create_pos_credit_sale_invoice_atomic: pos transaction % has no credit tender', _pos_transaction_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Line totals derived from the committed POS lines, not the client cart.
  SELECT
    COALESCE(SUM(
      (quantity * unit_price)
      - CASE
          WHEN discount_type = 'percent' THEN (quantity * unit_price) * COALESCE(discount_value, 0) / 100
          WHEN discount_type = 'fixed'   THEN COALESCE(discount_value, 0)
          ELSE 0
        END
    ), 0),
    COALESCE(SUM(COALESCE(tax_amount, 0)), 0)
  INTO v_subtotal, v_tax
  FROM public.pos_transaction_items
  WHERE transaction_id = _pos_transaction_id;

  IF v_mode = 'credit' THEN
    v_total  := v_credit_amount;
    v_status := 'draft'::invoice_status;
  ELSE
    -- Fully tendered transaction being formalised as an invoice: it is a real
    -- document from the moment it exists; settlement is recorded separately
    -- through the canonical payment allocation contract (ADR 0027).
    v_total  := COALESCE(v_txn.total, v_subtotal + v_tax);
    v_status := 'confirmed'::invoice_status;
  END IF;

  SELECT COALESCE(b.base_currency, 'USD') INTO v_currency
    FROM public.businesses b WHERE b.id = v_txn.business_id;

  v_invoice_no := public.get_next_invoice_number(v_txn.organization_id, v_txn.business_id);

  INSERT INTO public.invoices (
    organization_id, business_id, branch_id, contact_id,
    invoice_number, status, source,
    issue_date, due_date,
    subtotal, tax_amount, discount_amount, total, amount_paid,
    currency, notes, created_by, salesperson_id, confirmed_by
  ) VALUES (
    v_txn.organization_id, v_txn.business_id, v_txn.branch_id, v_txn.customer_id,
    v_invoice_no, v_status, 'pos',
    CURRENT_DATE, CURRENT_DATE + COALESCE(_due_days, 30),
    v_subtotal, v_tax, COALESCE(v_txn.discount_amount, 0), v_total, 0,
    v_currency,
    '[POS] Auto-generated from POS transaction ' || v_txn.transaction_number,
    _user_id, _user_id,
    CASE WHEN v_status = 'confirmed'::invoice_status THEN _user_id ELSE NULL END
  )
  RETURNING id INTO v_invoice_id;

  INSERT INTO public.invoice_items (
    invoice_id, business_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order
  )
  SELECT
    v_invoice_id, v_txn.business_id, i.product_id, i.description, i.quantity, i.unit_price,
    COALESCE(i.tax_rate, 0), COALESCE(i.tax_amount, 0),
    CASE WHEN i.discount_type = 'percent' THEN COALESCE(i.discount_value, 0) ELSE 0 END,
    i.line_total, COALESCE(i.sort_order, 0)
  FROM public.pos_transaction_items i
  WHERE i.transaction_id = _pos_transaction_id
  ORDER BY COALESCE(i.sort_order, 0);

  UPDATE public.pos_transactions
     SET invoice_id = v_invoice_id
   WHERE id = _pos_transaction_id;

  RETURN v_invoice_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.create_pos_credit_sale_invoice_atomic(uuid, integer, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_pos_credit_sale_invoice_atomic(uuid, integer, uuid, text) TO service_role;

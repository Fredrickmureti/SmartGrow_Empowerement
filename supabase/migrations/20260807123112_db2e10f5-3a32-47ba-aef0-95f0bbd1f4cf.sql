-- Phase 4b — `void_goods_receipt_atomic`.
--
-- `resolve_reversal_intent` has advertised a `goods_return` operation for
-- goods receipts since Phase 1, but no writer existed: the operation was
-- unreachable. This adds it in the same shape as `void_bill_atomic` /
-- `void_invoice_atomic` — one transaction, period-guarded, idempotent, and
-- posting only through `void_journal_entry_atomic`.
--
-- Stock is compensated, never deleted: each original `receipt` movement is
-- mirrored as a `return_out` under `reference_type = 'goods_receipt_void'`,
-- which also gives the idempotency probe.

CREATE OR REPLACE FUNCTION public.wms_reverse_gr_stock(
  _gr_id uuid,
  _actor uuid,
  _reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_grn     RECORD;
  v_item    RECORD;
  v_count   int := 0;
  v_already int := 0;
  v_any     boolean := false;
  v_all     boolean;
BEGIN
  SELECT id, organization_id, business_id, branch_id, warehouse_id,
         purchase_order_id, receipt_number
    INTO v_grn
    FROM public.goods_receipts WHERE id = _gr_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Goods receipt not found');
  END IF;

  -- Idempotency: compensating movements already written.
  SELECT count(*) INTO v_already
    FROM public.stock_movements
   WHERE reference_type = 'goods_receipt_void' AND reference_id = _gr_id;
  IF v_already > 0 THEN
    RETURN jsonb_build_object('success', true, 'movement_count', 0, 'already_reversed', true);
  END IF;

  -- Mirror every original receipt movement as an outbound return.
  WITH ins AS (
    INSERT INTO public.stock_movements (
      organization_id, business_id, branch_id, warehouse_id,
      product_id, movement_type, quantity, unit_cost,
      reference_type, reference_id, notes,
      lot_number, serial_number, created_by
    )
    SELECT sm.organization_id, sm.business_id, sm.branch_id, sm.warehouse_id,
           sm.product_id, 'return_out', sm.quantity, sm.unit_cost,
           'goods_receipt_void', _gr_id,
           'Goods returned — GRN ' || COALESCE(v_grn.receipt_number, _gr_id::text)
             || ' reversed. ' || COALESCE(_reason, ''),
           sm.lot_number, sm.serial_number, _actor
      FROM public.stock_movements sm
     WHERE sm.reference_type = 'goods_receipt'
       AND sm.reference_id = _gr_id
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM ins;

  -- Give the purchase order its open quantities back, and re-derive its status
  -- from the corrected receipts rather than assuming the previous value.
  FOR v_item IN
    SELECT gri.purchase_order_item_id, gri.quantity_received
      FROM public.goods_receipt_items gri
     WHERE gri.goods_receipt_id = _gr_id
       AND gri.purchase_order_item_id IS NOT NULL
  LOOP
    v_any := true;
    UPDATE public.purchase_order_items
       SET quantity_received = GREATEST(COALESCE(quantity_received, 0) - COALESCE(v_item.quantity_received, 0), 0),
           receipt_status = CASE
             WHEN GREATEST(COALESCE(quantity_received, 0) - COALESCE(v_item.quantity_received, 0), 0) <= 0 THEN 'pending'
             WHEN GREATEST(COALESCE(quantity_received, 0) - COALESCE(v_item.quantity_received, 0), 0) >= quantity THEN 'received'
             ELSE 'partial'
           END
     WHERE id = v_item.purchase_order_item_id;
  END LOOP;

  IF v_grn.purchase_order_id IS NOT NULL THEN
    SELECT bool_and(COALESCE(quantity_received, 0) >= quantity)
      INTO v_all
      FROM public.purchase_order_items
     WHERE purchase_order_id = v_grn.purchase_order_id;

    UPDATE public.purchase_orders
       SET status = CASE
             WHEN COALESCE(v_all, false) THEN 'received'
             WHEN EXISTS (SELECT 1 FROM public.purchase_order_items
                           WHERE purchase_order_id = v_grn.purchase_order_id
                             AND COALESCE(quantity_received, 0) > 0) THEN 'partial_received'
             ELSE 'sent'
           END
     WHERE id = v_grn.purchase_order_id
       AND status NOT IN ('cancelled', 'closed');
  END IF;

  RETURN jsonb_build_object('success', true, 'movement_count', v_count);
END;
$$;

GRANT EXECUTE ON FUNCTION public.wms_reverse_gr_stock(uuid, uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.wms_reverse_gr_stock(uuid, uuid, text) IS
  'Warehouse participant in goods-receipt reversal: writes compensating return_out movements and restores purchase-order received quantities. Called by void_goods_receipt_atomic; not an operator entry point.';


CREATE OR REPLACE FUNCTION public.void_goods_receipt_atomic(
  _gr_id uuid,
  _reason text,
  _void_date date DEFAULT NULL,
  _actor uuid DEFAULT NULL,
  _client_request_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_grn        public.goods_receipts%ROWTYPE;
  v_date       date := COALESCE(_void_date, CURRENT_DATE);
  v_actor      uuid := COALESCE(_actor, auth.uid());
  v_billed     int := 0;
  v_je         RECORD;
  v_rev        uuid;
  v_reversals  uuid[] := ARRAY[]::uuid[];
  v_stock      jsonb;
  v_tasks      jsonb;
BEGIN
  IF _gr_id IS NULL THEN
    RAISE EXCEPTION 'void_goods_receipt_atomic requires a goods receipt id' USING ERRCODE = '22023';
  END IF;
  IF _reason IS NULL OR btrim(_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to reverse a goods receipt.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_grn FROM public.goods_receipts WHERE id = _gr_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Goods receipt % not found.', _gr_id USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.user_belongs_to_org(v_grn.organization_id) THEN
    RAISE EXCEPTION 'Not authorized for this document.' USING ERRCODE = '42501';
  END IF;

  -- idempotent
  IF COALESCE(v_grn.status, 'draft') IN ('reversed', 'cancelled', 'voided') THEN
    RETURN jsonb_build_object(
      'result', 'already_reversed',
      'goods_receipt_id', _gr_id,
      'receipt_number', v_grn.receipt_number);
  END IF;

  IF COALESCE(v_grn.status, 'draft') <> 'completed' THEN
    RAISE EXCEPTION 'Goods receipt % was never completed — nothing was posted. Edit or delete the draft instead of returning goods.',
      COALESCE(v_grn.receipt_number, _gr_id::text) USING ERRCODE = '23514';
  END IF;

  -- A billed receipt is not reversible on its own: the liability exists and
  -- would be left behind. This mirrors the `billed` blocker that
  -- resolve_reversal_intent already reports, so the guard and the advice agree.
  SELECT count(*) INTO v_billed
    FROM public.bills b
   WHERE b.goods_receipt_id = _gr_id
     AND b.status::text <> 'void';

  IF v_billed > 0 THEN
    RAISE EXCEPTION
      'Goods receipt % is covered by % supplier bill(s). Void or credit the bill first, otherwise the liability stays behind.',
      COALESCE(v_grn.receipt_number, _gr_id::text), v_billed
      USING ERRCODE = '23514';
  END IF;

  IF v_grn.business_id IS NOT NULL AND NOT public.is_period_open(v_grn.business_id, v_date) THEN
    RAISE EXCEPTION 'The accounting period covering % is closed. Reverse the receipt in an open period instead.', v_date
      USING ERRCODE = '23514';
  END IF;

  -- ------------------------------------------------- reverse every live JE
  FOR v_je IN
    SELECT je.id
      FROM public.journal_entries je
     WHERE je.organization_id = v_grn.organization_id
       AND ((je.source_type = 'goods_receipt' AND je.source_id = _gr_id)
         OR (je.reference_type = 'goods_receipt' AND je.reference_id = _gr_id))
       AND je.status::text NOT IN ('voided', 'reversed')
  LOOP
    v_rev := public.void_journal_entry_atomic(
      v_je.id,
      'Reverse goods receipt ' || COALESCE(v_grn.receipt_number, _gr_id::text) || ': ' || _reason,
      v_actor,
      NULL,
      v_date);
    IF v_rev IS NOT NULL THEN
      v_reversals := v_reversals || v_rev;
    END IF;
  END LOOP;

  -- --------------------------------------------------------- warehouse legs
  v_stock := public.wms_reverse_gr_stock(_gr_id, v_actor, _reason);
  IF NOT COALESCE((v_stock->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'wms_reverse_gr_stock failed: %', v_stock->>'error';
  END IF;

  -- Open put-away / QC work for a receipt that no longer exists must not stay
  -- claimable by an operator (ADR: warehouse participates in reversal).
  v_tasks := public.wms_cancel_tasks_for_document('goods_receipt', _gr_id, _reason, v_actor);

  -- Three-way-match state described a receipt that is no longer in the books.
  DELETE FROM public.bill_grn_matches WHERE goods_receipt_id = _gr_id;

  UPDATE public.goods_receipts
     SET status     = 'reversed',
         notes      = COALESCE(notes || E'\n', '') || 'Reversed ' || v_date::text || ': ' || _reason,
         updated_at = now()
   WHERE id = _gr_id;

  INSERT INTO public.business_event_outbox (
    org_id, branch_id, warehouse_id,
    event_type, source_doc_type, source_doc_id,
    payload, status, idempotency_key, actor_user_id, source
  ) VALUES (
    v_grn.organization_id, v_grn.branch_id, v_grn.warehouse_id,
    'procurement.gr.reversed', 'goods_receipt', _gr_id,
    jsonb_build_object(
      'business_id', v_grn.business_id,
      'purchase_order_id', v_grn.purchase_order_id,
      'receipt_number', v_grn.receipt_number,
      'reason', _reason,
      'void_date', v_date,
      'reversal_journal_entry_ids', to_jsonb(v_reversals),
      'movement_count', v_stock->'movement_count'),
    'pending',
    'procurement.gr:' || _gr_id::text || ':reversed',
    v_actor,
    'procurement'
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN jsonb_build_object(
    'result', 'reversed',
    'goods_receipt_id', _gr_id,
    'receipt_number', v_grn.receipt_number,
    'void_date', v_date,
    'reversal_journal_entry_ids', to_jsonb(v_reversals),
    'movement_count', v_stock->'movement_count',
    'cancelled_tasks', v_tasks,
    'client_request_id', _client_request_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.void_goods_receipt_atomic(uuid, text, date, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.void_goods_receipt_atomic(uuid, text, date, uuid, text) IS
  'Canonical single writer for goods-receipt reversal (the goods_return operation advertised by resolve_reversal_intent). One transaction: reverses the GR/NI journal through void_journal_entry_atomic, writes compensating stock movements, restores purchase-order quantities, cancels open warehouse tasks, clears three-way-match rows and marks the receipt reversed. Period-guarded, idempotent, refuses while a live bill covers the receipt.';
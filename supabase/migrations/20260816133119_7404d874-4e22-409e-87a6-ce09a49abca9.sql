-- =====================================================================
-- Phase B.2 — Goods receipt reversal / return to supplier vs landed cost
--
-- 1. One shared authority for "is this receipt still carrying landed cost":
--    landed_cost_receipt_encumbrance() reads the canonical voucher +
--    allocation tables. Nothing recomputes this locally.
-- 2. The reversal intent authority is ANNOTATED, not forked: Landed Cost
--    stays a consumer of resolve_reversal_intent_finance and decorates its
--    goods_receipt verdict. void_goods_receipt_atomic therefore inherits the
--    block for free through assert_can_reverse().
-- 3. purchase_return_create / _dispatch refuse a goods return from an
--    encumbered receipt.
-- 4. Defect: purchase_return_dispatch emitted movement_type 'return', which is
--    not in the stock movement vocabulary (the insert could never succeed) and
--    is handled by neither cost-layer branch. It now emits 'vendor_return',
--    which consumes cost layers at their landed cost.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.landed_cost_receipt_encumbrance(_goods_receipt_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH v AS (
    SELECT DISTINCT lv.id, lv.voucher_number, lv.status, lv.total_base_amount,
           lv.capitalized_amount, lv.expensed_amount
      FROM public.landed_cost_vouchers lv
     WHERE lv.status NOT IN ('draft', 'cancelled', 'reversed')
       AND (
         EXISTS (SELECT 1 FROM public.landed_cost_voucher_receipts r
                  WHERE r.voucher_id = lv.id AND r.goods_receipt_id = _goods_receipt_id)
         OR EXISTS (SELECT 1 FROM public.landed_cost_allocations a
                     WHERE a.voucher_id = lv.id AND a.goods_receipt_id = _goods_receipt_id)
       )
  )
  SELECT jsonb_build_object(
    'goods_receipt_id', _goods_receipt_id,
    'encumbered',       EXISTS (SELECT 1 FROM v),
    'posted_count',     (SELECT count(*)::int FROM v WHERE status = 'posted'),
    'open_count',       (SELECT count(*)::int FROM v WHERE status <> 'posted'),
    'capitalized',      COALESCE((SELECT SUM(capitalized_amount) FROM v WHERE status = 'posted'), 0),
    'vouchers',         COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                          'id', id, 'voucher_number', voucher_number,
                                          'status', status, 'amount', total_base_amount)
                                        ORDER BY voucher_number)
                                    FROM v), '[]'::jsonb),
    'voucher_numbers',  COALESCE((SELECT string_agg(voucher_number, ', ' ORDER BY voucher_number)
                                    FROM v), ''));
$$;

REVOKE ALL ON FUNCTION public.landed_cost_receipt_encumbrance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.landed_cost_receipt_encumbrance(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.landed_cost_receipt_encumbrance(uuid) IS
'Single authority for whether a goods receipt still carries landed cost charges (allocated or posted). Consumed by the reversal intent authority and the purchase return engine.';

CREATE OR REPLACE FUNCTION public.landed_cost_receipt_block_reason(_goods_receipt_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN NOT COALESCE((e->>'encumbered')::boolean, false) THEN NULL
    WHEN (e->>'posted_count')::int > 0 THEN
      'Landed cost ' || (e->>'voucher_numbers') || ' has been posted against this receipt and '
      || to_char((e->>'capitalized')::numeric, 'FM999999999990.00')
      || ' of charges are capitalised into the stock value. Reverse the landed cost first, '
      || 'otherwise the charges stay in inventory after the goods leave.'
    ELSE
      'Landed cost ' || (e->>'voucher_numbers') || ' is allocated to this receipt. '
      || 'Cancel or re-allocate the landed cost first, otherwise the charges would be '
      || 'spread over quantities that are no longer here.'
  END
  FROM (SELECT public.landed_cost_receipt_encumbrance(_goods_receipt_id) AS e) s;
$$;

REVOKE ALL ON FUNCTION public.landed_cost_receipt_block_reason(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.landed_cost_receipt_block_reason(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.landed_cost_assert_receipt_unencumbered(
  _goods_receipt_id uuid,
  _operation        text DEFAULT 'goods_return')
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_reason text;
BEGIN
  IF _goods_receipt_id IS NULL THEN RETURN; END IF;
  v_reason := public.landed_cost_receipt_block_reason(_goods_receipt_id);
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION '%', v_reason USING ERRCODE = '23514', HINT = 'LANDED_COST_ENCUMBERED';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.landed_cost_assert_receipt_unencumbered(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.landed_cost_assert_receipt_unencumbered(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public._landed_cost_annotate_reversal_intent(_intent jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_grn    uuid := NULLIF(_intent->>'document_id', '')::uuid;
  v_enc    jsonb;
  v_reason text;
  v_ops    jsonb := '[]'::jsonb;
  v_op     jsonb;
BEGIN
  IF _intent->>'document_type' IS DISTINCT FROM 'goods_receipt' OR v_grn IS NULL THEN
    RETURN _intent;
  END IF;

  v_enc := public.landed_cost_receipt_encumbrance(v_grn);
  IF NOT COALESCE((v_enc->>'encumbered')::boolean, false) THEN
    RETURN _intent;
  END IF;

  v_reason := public.landed_cost_receipt_block_reason(v_grn);

  FOR v_op IN SELECT * FROM jsonb_array_elements(COALESCE(_intent->'operations', '[]'::jsonb)) LOOP
    IF v_op->>'operation' = 'goods_return' THEN
      v_op := v_op || jsonb_build_object('allowed', false, 'blocked_reason', v_reason);
    END IF;
    v_ops := v_ops || v_op;
  END LOOP;

  v_ops := v_ops || jsonb_build_array(jsonb_build_object(
    'operation', 'reverse_landed_cost',
    'allowed',   true,
    'label',     'Reverse the landed cost first',
    'description',
      'Unwinds landed cost ' || (v_enc->>'voucher_numbers') ||
      ' from the stock value and the ledger. Once that is done the goods can be returned.',
    'blocked_reason', NULL,
    'landed_cost', v_enc));

  RETURN _intent
      || jsonb_build_object(
           'operations',   v_ops,
           'recommended',  'reverse_landed_cost',
           'landed_cost',  v_enc,
           'blockers',     COALESCE(_intent->'blockers', '[]'::jsonb) || '["landed_cost_encumbered"]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public._landed_cost_annotate_reversal_intent(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._landed_cost_annotate_reversal_intent(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_reversal_intent(_document_type text, _document_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _document_id IS NULL THEN
    RAISE EXCEPTION 'resolve_reversal_intent requires a document id' USING ERRCODE = '22023';
  END IF;

  IF _document_type = 'pos_transaction' THEN
    RETURN public.resolve_reversal_intent_pos(_document_id);
  ELSIF _document_type = 'payroll_run' THEN
    RETURN public.resolve_reversal_intent_payroll(_document_id);
  ELSIF _document_type = 'vendor_credit_note' THEN
    RETURN public.resolve_reversal_intent_vendor_credit_note(_document_id);
  ELSIF _document_type = 'expense' THEN
    RETURN public.resolve_reversal_intent_expense(_document_id);
  ELSIF _document_type = 'customer_refund' THEN
    RETURN public.resolve_reversal_intent_customer_refund(_document_id);
  ELSIF _document_type = 'goods_receipt' THEN
    -- Landed Cost annotates the finance authority's verdict; it never forks it.
    RETURN public._landed_cost_annotate_reversal_intent(
             public.resolve_reversal_intent_finance(_document_type, _document_id));
  ELSE
    RETURN public.resolve_reversal_intent_finance(_document_type, _document_id);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.purchase_return_create(
  _business_id uuid, _vendor_id uuid, _lines jsonb,
  _return_kind text DEFAULT 'goods'::text,
  _goods_receipt_id uuid DEFAULT NULL::uuid,
  _bill_id uuid DEFAULT NULL::uuid,
  _warehouse_id uuid DEFAULT NULL::uuid,
  _return_date date DEFAULT NULL::date,
  _reason_code text DEFAULT NULL::text,
  _reason text DEFAULT NULL::text,
  _notes text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_org uuid; v_branch uuid; v_grn public.goods_receipts;
  v_currency text; v_rate numeric := 1; v_base text;
  v_id uuid; v_pr public.purchase_returns; v_totals jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  IF NOT public.user_can_access_business(v_uid, _business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF _return_kind NOT IN ('goods','financial') THEN
    RAISE EXCEPTION 'Unknown return kind %', _return_kind USING ERRCODE='22023';
  END IF;

  SELECT organization_id, base_currency INTO v_org, v_base FROM public.businesses WHERE id = _business_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Business not found' USING ERRCODE='22023'; END IF;
  IF NOT public.user_has_module_permission(v_uid, v_org, _business_id, 'purchases', 'create') THEN
    RAISE EXCEPTION 'You do not have permission to create purchase returns' USING ERRCODE='42501';
  END IF;

  IF _goods_receipt_id IS NOT NULL THEN
    SELECT * INTO v_grn FROM public.goods_receipts WHERE id = _goods_receipt_id;
    IF v_grn.id IS NULL OR v_grn.business_id <> _business_id THEN
      RAISE EXCEPTION 'Goods receipt not found for this company' USING ERRCODE='22023';
    END IF;
    v_branch := v_grn.branch_id;

    -- Goods leaving a receipt that still carries landed cost would strand the
    -- capitalised charges in inventory. Landed cost is reversed first.
    IF _return_kind = 'goods' THEN
      PERFORM public.landed_cost_assert_receipt_unencumbered(_goods_receipt_id, 'goods_return');
    END IF;
  ELSIF _return_kind = 'goods' THEN
    RAISE EXCEPTION 'A goods return must originate from a goods receipt' USING ERRCODE='22023';
  END IF;

  SELECT COALESCE(b.currency, po.currency, v_base, 'USD')
    INTO v_currency
    FROM (SELECT 1) x
    LEFT JOIN public.bills b ON b.id = _bill_id
    LEFT JOIN public.purchase_orders po ON po.id = v_grn.purchase_order_id;
  v_currency := COALESCE(v_currency, v_base, 'USD');

  IF v_currency IS DISTINCT FROM v_base THEN
    SELECT rate INTO v_rate FROM public.exchange_rates
     WHERE organization_id = v_org AND from_currency = v_currency AND to_currency = v_base
       AND effective_date <= COALESCE(_return_date, CURRENT_DATE)
     ORDER BY effective_date DESC LIMIT 1;
    v_rate := COALESCE(v_rate, 1);
  END IF;

  PERFORM public._pret_lifecycle_begin();

  INSERT INTO public.purchase_returns(
    organization_id, business_id, branch_id, vendor_id, return_number, return_date, status,
    return_kind, goods_receipt_id, purchase_order_id, bill_id, warehouse_id,
    reason_code, reason, notes, currency, exchange_rate,
    subtotal, tax_amount, total, created_by)
  VALUES (
    v_org, _business_id, COALESCE(v_branch, (SELECT branch_id FROM public.warehouses WHERE id = _warehouse_id)),
    _vendor_id, NULL, COALESCE(_return_date, CURRENT_DATE), 'draft',
    _return_kind, _goods_receipt_id, v_grn.purchase_order_id, _bill_id,
    COALESCE(_warehouse_id, v_grn.warehouse_id),
    _reason_code, _reason, _notes, v_currency, v_rate, 0, 0, 0, v_uid)
  RETURNING id INTO v_id;

  v_totals := public._pret_write_lines(v_id, _lines);

  SELECT * INTO v_pr FROM public.purchase_returns WHERE id = v_id;
  PERFORM public._pret_log(v_pr, 'created', NULL, 'draft', v_totals);

  RETURN jsonb_build_object('success', true, 'id', v_id,
                            'return_number', v_pr.return_number, 'totals', v_totals);
END
$$;

CREATE OR REPLACE FUNCTION public.purchase_return_dispatch(
  _id uuid, _row_version integer,
  _dispatch_date date DEFAULT NULL::date,
  _tracking_reference text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_pr public.purchase_returns; v_branch uuid; v_moves int := 0; v_prod RECORD;
BEGIN
  v_pr := public._pret_load(_id, _row_version);
  IF v_pr.status <> 'approved' THEN
    RAISE EXCEPTION 'Only approved returns can be dispatched' USING ERRCODE='22023';
  END IF;
  IF v_pr.return_kind <> 'goods' THEN
    RAISE EXCEPTION 'A financial adjustment has no goods to dispatch' USING ERRCODE='22023';
  END IF;
  IF v_pr.warehouse_id IS NULL THEN
    RAISE EXCEPTION 'This return has no warehouse — stock cannot be released' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stock_movements
              WHERE reference_type='purchase_return' AND reference_id=_id) THEN
    RAISE EXCEPTION 'Stock for this return has already been released' USING ERRCODE='22023';
  END IF;

  -- Re-check at the moment stock actually leaves: a landed cost may have been
  -- posted between drafting and dispatch.
  PERFORM public.landed_cost_assert_receipt_unencumbered(v_pr.goods_receipt_id, 'goods_return');

  SELECT COALESCE(v_pr.branch_id, w.branch_id) INTO v_branch
    FROM public.warehouses w WHERE w.id = v_pr.warehouse_id;
  IF v_branch IS NULL THEN
    RAISE EXCEPTION 'Cannot resolve the branch for this warehouse' USING ERRCODE='22023';
  END IF;

  -- 'vendor_return' is the canonical outbound vocabulary: it is permitted by
  -- the movement type constraint and consumes cost layers at their landed
  -- cost. The previous 'return' was in neither.
  INSERT INTO public.stock_movements(
    organization_id, business_id, branch_id, warehouse_id, product_id, movement_type,
    quantity, unit_cost, reference_type, reference_id, notes, created_by,
    lot_number, serial_number, source_packaging_id, source_uom_id, source_location_id, movement_date)
  SELECT v_pr.organization_id, v_pr.business_id, v_branch, v_pr.warehouse_id, ri.product_id, 'vendor_return',
         -ri.quantity, COALESCE(ri.unit_cost_basis, ri.unit_price), 'purchase_return', v_pr.id,
         'Purchase return ' || v_pr.return_number || ' dispatched to vendor',
         auth.uid(), ri.lot_number, ri.serial_number, ri.packaging_id, ri.display_uom_id,
         ri.location_id, COALESCE(_dispatch_date, CURRENT_DATE)::timestamptz
    FROM public.purchase_return_items ri
   WHERE ri.purchase_return_id = v_pr.id AND ri.product_id IS NOT NULL;
  GET DIAGNOSTICS v_moves = ROW_COUNT;

  -- Layer consumption changed the surviving stock mix; re-derive AVCO from the
  -- canonical valuation writer.
  FOR v_prod IN SELECT DISTINCT product_id FROM public.purchase_return_items
                 WHERE purchase_return_id = v_pr.id AND product_id IS NOT NULL
  LOOP
    PERFORM public.inventory_sync_avco_from_layers(
      v_pr.business_id, v_prod.product_id, v_pr.warehouse_id);
  END LOOP;

  PERFORM public._pret_lifecycle_begin();
  UPDATE public.purchase_returns
     SET status='dispatched', dispatched_at=now(), dispatched_by=auth.uid(),
         rma_reference=COALESCE(_tracking_reference, rma_reference),
         row_version=row_version+1, updated_at=now()
   WHERE id=_id;
  SELECT * INTO v_pr FROM public.purchase_returns WHERE id=_id;
  PERFORM public._pret_log(v_pr, 'dispatched', 'approved', 'dispatched',
                           jsonb_build_object('stock_movements', v_moves,
                                              'tracking_reference', _tracking_reference));
  PERFORM public._pret_emit_outbox(v_pr, 'dispatched',
    jsonb_build_object('return_number', v_pr.return_number,
                       'vendor_id', v_pr.vendor_id,
                       'rma_reference', v_pr.rma_reference,
                       'stock_movements', v_moves,
                       'dispatched_at', v_pr.dispatched_at));
  RETURN jsonb_build_object('success', true, 'row_version', v_pr.row_version, 'stock_movements', v_moves);
END
$$;

-- P0-2: receive_inbound_shipment created a DRAFT goods receipt, incremented the
-- PO lines itself and stopped. No stock_movements, no Dr Inventory / Cr GRNI
-- journal — yet it closed the PO. Route it through the canonical posting path
-- (complete_goods_receipt_atomic -> wms_apply_gr_stock + finance_post_gr_journal),
-- which also owns the PO receipt roll-up, so the local increment is removed to
-- avoid double-counting. Also fixes the undefined variables in the automatic
-- GRN-number branch.
CREATE OR REPLACE FUNCTION public.receive_inbound_shipment(
  _shipment_id uuid,
  _lines jsonb,
  _actor uuid,
  _receipt_number text DEFAULT NULL,
  _receipt_date date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_ship RECORD;
  v_po RECORD;
  v_grn_id uuid;
  v_number text := _receipt_number;
  v_line jsonb;
  v_item RECORD;
  v_outstanding numeric;
  v_qty numeric;
  v_sort int := 0;
  v_wh uuid;
  v_branch uuid;
  v_post jsonb;
BEGIN
  IF _actor IS NULL THEN RAISE EXCEPTION 'actor is required'; END IF;
  IF _lines IS NULL OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'at least one line is required';
  END IF;

  SELECT * INTO v_ship FROM public.inbound_shipments
    WHERE id=_shipment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'shipment not found'; END IF;
  IF NOT public.user_has_business_access(_actor, v_ship.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE='42501';
  END IF;
  IF v_ship.status::text <> 'arrived' THEN
    RAISE EXCEPTION 'shipment is % — expected arrived', v_ship.status;
  END IF;
  IF v_ship.purchase_order_id IS NULL THEN
    RAISE EXCEPTION 'shipment % has no purchase_order_id — cannot receive without PO', _shipment_id;
  END IF;

  SELECT id, organization_id, business_id, branch_id, po_number
    INTO v_po FROM public.purchase_orders
    WHERE id=v_ship.purchase_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PO % not found', v_ship.purchase_order_id; END IF;

  v_wh := v_ship.warehouse_id;
  IF v_wh IS NULL THEN
    RAISE EXCEPTION 'shipment has no warehouse — set inbound_shipments.warehouse_id before receiving';
  END IF;
  v_branch := COALESCE(v_ship.branch_id, v_po.branch_id);

  IF v_number IS NULL THEN
    v_number := public.get_next_grn_number(v_po.organization_id, v_po.business_id, v_branch);
  END IF;

  INSERT INTO public.goods_receipts
    (organization_id, business_id, branch_id, warehouse_id,
     purchase_order_id, receipt_number, receipt_date, received_by, status,
     notes)
  VALUES
    (v_po.organization_id, v_po.business_id, v_branch, v_wh,
     v_po.id, v_number, COALESCE(_receipt_date, CURRENT_DATE), _actor, 'draft',
     'Received from ASN ' || v_ship.shipment_number)
  RETURNING id INTO v_grn_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    v_sort := v_sort + 1;
    v_qty := COALESCE((v_line->>'quantity_received')::numeric, 0);
    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'line %: quantity_received must be positive (got %)', v_sort, v_qty;
    END IF;

    SELECT isi.id AS shipment_item_id, isi.expected_quantity, isi.product_id,
           poi.id AS po_item_id, poi.quantity, poi.quantity_received, poi.description
      INTO v_item
      FROM public.inbound_shipment_items isi
      JOIN public.purchase_order_items poi ON poi.id = isi.purchase_order_item_id
     WHERE isi.id = (v_line->>'shipment_item_id')::uuid
       AND isi.shipment_id = _shipment_id
     FOR UPDATE OF poi;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'line %: shipment_item_id % is not on shipment', v_sort, v_line->>'shipment_item_id';
    END IF;

    v_outstanding := COALESCE(v_item.quantity, 0) - COALESCE(v_item.quantity_received, 0);
    IF v_qty > v_outstanding THEN
      RAISE EXCEPTION 'line %: over-receipt — requested % but only % outstanding on PO line %',
        v_sort, v_qty, v_outstanding, v_item.po_item_id;
    END IF;

    -- purchase_order_items.quantity_received is NOT touched here: the posting
    -- path (wms_apply_gr_stock) owns that roll-up and the PO status.
    INSERT INTO public.goods_receipt_items
      (goods_receipt_id, purchase_order_item_id, product_id,
       description, quantity_ordered, quantity_received,
       lot_number, serial_number, notes, sort_order, branch_id)
    VALUES
      (v_grn_id, v_item.po_item_id, v_item.product_id,
       v_item.description, v_item.quantity, v_qty,
       NULLIF(v_line->>'lot_number',''), NULLIF(v_line->>'serial_number',''),
       NULLIF(v_line->>'notes',''), v_sort, v_branch);
  END LOOP;

  -- Canonical posting: stock movements + Dr Inventory / Cr GRNI + PO roll-up
  -- + procurement.gr.posted. Identical to the direct-GRN control path.
  v_post := public.complete_goods_receipt_atomic(v_grn_id, _actor);
  IF NOT COALESCE((v_post->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'goods receipt posting failed: %', v_post->>'error';
  END IF;

  UPDATE public.inbound_shipments
     SET status='received', received_at=now(), updated_at=now()
   WHERE id=_shipment_id;

  PERFORM public._emit_grn_outbox(v_grn_id, 'received',
    jsonb_build_object(
      'shipment_id', _shipment_id,
      'purchase_order_id', v_po.id,
      'receipt_number', v_number,
      'warehouse_id', v_wh,
      'line_count', jsonb_array_length(_lines)
    ));

  RETURN jsonb_build_object(
    'success', true,
    'goods_receipt_id', v_grn_id,
    'receipt_number', v_number,
    'shipment_id', _shipment_id,
    'purchase_order_id', v_po.id,
    'movement_count', v_post->'movement_count',
    'journal_id', v_post->'journal_id'
  );
END;
$fn$;
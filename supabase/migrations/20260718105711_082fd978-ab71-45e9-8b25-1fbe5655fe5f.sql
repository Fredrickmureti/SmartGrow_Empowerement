
-- Batch G — GR reconstruction from ASN --------------------------------------

-- Governance: register grn.receive duty (idempotent) and SoD conflicts.
INSERT INTO public.governance_duties (duty_code, label, domain, description)
VALUES ('grn.receive', 'Receive goods', 'procurement',
        'Authoring party for goods receipts against a purchase order / ASN')
ON CONFLICT (duty_code) DO NOTHING;

INSERT INTO public.governance_sod_conflicts (duty_a, duty_b, severity, rationale) VALUES
  ('grn.receive', 'po.approve', 'high',
   'Approver of a PO cannot also record the goods receipt against it — separation of authorisation and custody.'),
  ('asn.manage', 'grn.receive', 'high',
   'ASN manager (declares expected quantities) cannot record the physical receipt — split between declaration and custody.'),
  ('bill.approve', 'grn.receive', 'high',
   'Bill approver cannot also record the goods receipt (blocks a single actor from closing the 3-way match on themselves).')
ON CONFLICT DO NOTHING;

-- Outbox helper for GR --------------------------------------------------------
CREATE OR REPLACE FUNCTION public._emit_grn_outbox(_grn_id uuid, _state text, _payload jsonb)
RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
DECLARE v_org uuid; v_branch uuid; v_wh uuid;
BEGIN
  SELECT organization_id, branch_id, warehouse_id
    INTO v_org, v_branch, v_wh
    FROM public.goods_receipts WHERE id=_grn_id;
  INSERT INTO public.business_event_outbox
    (org_id, branch_id, warehouse_id, source, event_type,
     source_doc_type, source_doc_id, payload,
     idempotency_key, status, actor_user_id, created_at)
  VALUES (v_org, v_branch, v_wh, 'procurement',
          'procurement.grn.' || _state,
          'goods_receipt', _grn_id, _payload,
          'procurement.grn.' || _state || ':' || _grn_id::text || ':' || _state,
          'pending', auth.uid(), now())
  ON CONFLICT (idempotency_key) DO NOTHING;
END $$;

-- receive_inbound_shipment ----------------------------------------------------
-- Contract:
--   _lines := jsonb array of
--     { shipment_item_id: uuid, quantity_received: numeric,
--       lot_number?: text, serial_number?: text, notes?: text }
--   Each shipment_item_id must belong to _shipment_id and its
--   purchase_order_item quantity ordered minus already-received must be >=
--   quantity_received.
CREATE OR REPLACE FUNCTION public.receive_inbound_shipment(
  _shipment_id uuid,
  _lines jsonb,
  _actor uuid,
  _receipt_number text DEFAULT NULL,
  _receipt_date date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
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

  SELECT id, organization_id, business_id, branch_id, warehouse_id, po_number
    INTO v_po FROM public.purchase_orders
    WHERE id=v_ship.purchase_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PO % not found', v_ship.purchase_order_id; END IF;

  v_wh := COALESCE(v_ship.warehouse_id, v_po.warehouse_id);
  IF v_wh IS NULL THEN
    RAISE EXCEPTION 'no warehouse resolved for GR (set on shipment or PO)';
  END IF;
  v_branch := COALESCE(v_ship.branch_id, v_po.branch_id);

  IF v_number IS NULL THEN
    v_number := 'GRN-' || to_char(now(),'YYYYMMDD') || '-' || substr(gen_random_uuid()::text,1,8);
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

    -- Resolve the shipment line → PO line (single canonical path).
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

    INSERT INTO public.goods_receipt_items
      (goods_receipt_id, purchase_order_item_id, product_id,
       description, quantity_ordered, quantity_received,
       lot_number, serial_number, notes, sort_order, branch_id)
    VALUES
      (v_grn_id, v_item.po_item_id, v_item.product_id,
       v_item.description, v_item.quantity, v_qty,
       NULLIF(v_line->>'lot_number',''), NULLIF(v_line->>'serial_number',''),
       NULLIF(v_line->>'notes',''), v_sort, v_branch);

    UPDATE public.purchase_order_items
       SET quantity_received = COALESCE(quantity_received, 0) + v_qty
     WHERE id = v_item.po_item_id;
  END LOOP;

  -- Flip shipment to received and stamp received_at.
  UPDATE public.inbound_shipments
     SET status='received', received_at=now(), updated_at=now()
   WHERE id=_shipment_id;

  -- Reflect PO status if any lines are now partial/fully received.
  UPDATE public.purchase_orders po
     SET status = CASE
                    WHEN NOT EXISTS (
                      SELECT 1 FROM public.purchase_order_items x
                       WHERE x.purchase_order_id = po.id
                         AND COALESCE(x.quantity_received,0) < COALESCE(x.quantity,0)
                    ) THEN 'received'::po_status
                    ELSE 'partial_received'::po_status
                  END,
         updated_at = now()
   WHERE po.id = v_po.id
     AND po.status::text NOT IN ('closed','cancelled','rejected');

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
    'purchase_order_id', v_po.id
  );
END $$;

GRANT EXECUTE ON FUNCTION public.receive_inbound_shipment(uuid, jsonb, uuid, text, date) TO authenticated;

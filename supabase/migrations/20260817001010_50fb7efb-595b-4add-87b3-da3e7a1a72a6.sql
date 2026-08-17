
-- ============================================================
-- P2-1: every receipt path produces a plate + putaway task
-- ============================================================

CREATE OR REPLACE FUNCTION public.wms_resolve_receiving_staging_location(p_warehouse_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT id FROM public.stock_locations
   WHERE warehouse_id = p_warehouse_id
     AND is_active
     AND COALESCE(is_blocked, false) = false
     AND location_type <> 'quarantine'
   ORDER BY is_receiving_staging DESC NULLS LAST,
            (location_type = 'staging') DESC,
            is_default DESC NULLS LAST,
            code
   LIMIT 1;
$function$;

DROP FUNCTION IF EXISTS public.receive_goods_to_wms(uuid, uuid);

CREATE OR REPLACE FUNCTION public.receive_goods_to_wms(
  p_goods_receipt_id uuid,
  p_staging_location_id uuid,
  p_actor uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_gr record;
  v_line record;
  v_lpn_id uuid;
  v_lpn_code text;
  v_dest_id uuid;
  v_task_id uuid;
  v_created_tasks int := 0;
  v_created_plates int := 0;
  v_suggestion record;
  v_sug_rank int;
  v_task_ids uuid[] := ARRAY[]::uuid[];
  v_default_location uuid;
  v_actor uuid := COALESCE(auth.uid(), p_actor);
  v_relieved int;
BEGIN
  SELECT id, organization_id, business_id, branch_id, warehouse_id
    INTO v_gr
  FROM public.goods_receipts
  WHERE id = p_goods_receipt_id;
  IF v_gr.id IS NULL THEN RAISE EXCEPTION 'goods_receipt % not found', p_goods_receipt_id; END IF;
  IF v_actor IS NULL OR NOT user_can_access_business(v_actor, v_gr.business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  PERFORM 1 FROM public.stock_locations
   WHERE id = p_staging_location_id AND warehouse_id = v_gr.warehouse_id AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'staging location % not in warehouse %', p_staging_location_id, v_gr.warehouse_id;
  END IF;

  SELECT id INTO v_default_location
    FROM public.stock_locations
   WHERE warehouse_id = v_gr.warehouse_id AND is_default
   LIMIT 1;

  PERFORM public.wms_ensure_default_putaway_strategies(v_gr.warehouse_id);

  FOR v_line IN
    SELECT gri.id AS line_id, gri.product_id, gri.quantity_received, gri.lot_number,
           gri.packaging_id
    FROM public.goods_receipt_items gri
    WHERE gri.goods_receipt_id = p_goods_receipt_id
      AND COALESCE(gri.quantity_received, 0) > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.wms_tasks t
        WHERE t.task_type = 'putaway'
          AND (t.metadata->>'goods_receipt_item_id')::uuid = gri.id
      )
  LOOP
    v_lpn_code := 'LPN-' || to_char(now(), 'YY') || upper(substr(md5(gen_random_uuid()::text), 1, 6));
    INSERT INTO public.wms_license_plates (
      organization_id, business_id, branch_id, warehouse_id,
      code, lpn_type, status, current_location_id, created_by
    ) VALUES (
      v_gr.organization_id, v_gr.business_id, v_gr.branch_id, v_gr.warehouse_id,
      v_lpn_code, 'pallet', 'open', p_staging_location_id, v_actor
    ) RETURNING id INTO v_lpn_id;
    v_created_plates := v_created_plates + 1;

    -- The goods receipt ledger already created the balance at the warehouse
    -- default location. Staging RELOCATES it — it must never add stock again.
    -- This relief is unconditional: when staging IS the default location the
    -- balance simply moves from the loose location quant onto the plate.
    -- package_id is the commercial packaging level (product_packaging);
    -- the physical container belongs in lpn_id.
    -- P2-2 (writer invariant): if there is nothing to relieve, creating the
    -- plate quant would DOUBLE-COUNT the receipt. Fail loudly instead.
    IF v_default_location IS NULL THEN
      RAISE EXCEPTION 'WMS_STAGING_NO_DEFAULT_LOCATION: warehouse % has no default stock location to relieve', v_gr.warehouse_id;
    END IF;

    UPDATE public.stock_quants
       SET quantity = quantity - v_line.quantity_received,
           updated_at = now()
     WHERE product_id  = v_line.product_id
       AND location_id = v_default_location
       AND COALESCE(lot_number,'') = COALESCE(v_line.lot_number,'')
       AND package_id IS NULL
       AND lpn_id IS NULL;
    GET DIAGNOSTICS v_relieved = ROW_COUNT;

    IF v_relieved = 0 THEN
      RAISE EXCEPTION
        'WMS_STAGING_UNRELIEVED_BALANCE: no loose quant for product % (lot %) at location % to relocate onto a plate — staging would double-count receipt %',
        v_line.product_id, COALESCE(v_line.lot_number,'-'), v_default_location, p_goods_receipt_id;
    END IF;

    INSERT INTO public.stock_quants AS q (
      organization_id, business_id, branch_id,
      product_id, location_id, lot_number, package_id, lpn_id, quantity
    ) VALUES (
      v_gr.organization_id, v_gr.business_id, v_gr.branch_id,
      v_line.product_id, p_staging_location_id, v_line.lot_number,
      v_line.packaging_id, v_lpn_id, v_line.quantity_received
    )
    ON CONFLICT (
      product_id, location_id,
      COALESCE(lot_number, ''),
      COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(owner_id,   '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(lpn_id,     '00000000-0000-0000-0000-000000000000'::uuid)
    ) DO UPDATE SET quantity = q.quantity + EXCLUDED.quantity, updated_at = now();

    v_dest_id := NULL; v_sug_rank := 0;

    INSERT INTO public.wms_tasks (
      organization_id, business_id, branch_id, warehouse_id,
      task_type, state, priority,
      source_doc_type, source_doc_id,
      source_location_id, destination_location_id,
      product_id, lot_number, lpn_id, quantity,
      metadata, created_by
    ) VALUES (
      v_gr.organization_id, v_gr.business_id, v_gr.branch_id, v_gr.warehouse_id,
      'putaway', 'pending', 100,
      'goods_receipt', p_goods_receipt_id,
      p_staging_location_id, NULL,
      v_line.product_id, v_line.lot_number, v_lpn_id, v_line.quantity_received,
      jsonb_build_object('goods_receipt_item_id', v_line.line_id),
      v_actor
    ) RETURNING id INTO v_task_id;
    v_created_tasks := v_created_tasks + 1;
    v_task_ids := v_task_ids || v_task_id;

    FOR v_suggestion IN
      SELECT * FROM public.wms_suggest_putaway_location(
        v_gr.warehouse_id, v_line.product_id, v_line.quantity_received, v_lpn_id
      )
    LOOP
      v_sug_rank := v_sug_rank + 1;
      IF v_dest_id IS NULL THEN v_dest_id := v_suggestion.location_id; END IF;
      INSERT INTO public.wms_putaway_suggestions (
        organization_id, business_id, branch_id, warehouse_id,
        task_id, location_id, rank, score, reason, strategy_id
      ) VALUES (
        v_gr.organization_id, v_gr.business_id, v_gr.branch_id, v_gr.warehouse_id,
        v_task_id, v_suggestion.location_id, v_sug_rank,
        v_suggestion.score, v_suggestion.reason, v_suggestion.strategy_id
      );
    END LOOP;

    IF v_dest_id IS NOT NULL THEN
      UPDATE public.wms_tasks SET destination_location_id = v_dest_id WHERE id = v_task_id;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'tasks_created', v_created_tasks,
    'plates_created', v_created_plates,
    'task_ids', to_jsonb(v_task_ids)
  );
END;
$function$;

-- ASN-direct receipts now stage exactly like workspace receipts.
CREATE OR REPLACE FUNCTION public.receive_inbound_shipment(
  _shipment_id uuid, _lines jsonb, _actor uuid,
  _receipt_number text DEFAULT NULL::text, _receipt_date date DEFAULT NULL::date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  v_staging uuid;
  v_staged jsonb := NULL;
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

  -- P2-1: physical execution parity. An ASN-direct receipt must leave the same
  -- handling unit + putaway task trail as a receiving-workspace session.
  -- Idempotent: receive_goods_to_wms skips lines that already carry a task, so
  -- wms_post_receiving_session calling it again is a no-op.
  v_staging := public.wms_resolve_receiving_staging_location(v_wh);
  IF v_staging IS NOT NULL THEN
    v_staged := public.receive_goods_to_wms(v_grn_id, v_staging, _actor);
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
    'journal_id', v_post->'journal_id',
    'staged', v_staged,
    'staging_location_id', v_staging
  );
END;
$function$;

-- ============================================================
-- P2-2 (visibility): mixed plate/loose scope is reported by the drift audit
-- ============================================================
CREATE OR REPLACE FUNCTION public.check_stock_quant_drift(_business_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(scope text, warehouse_id uuid, product_id uuid, lot_number text, quant_qty numeric, projected_qty numeric, drift numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH quant_by_wh AS (
    SELECT l.warehouse_id AS wh, q.product_id AS pid, SUM(q.quantity) AS qty
      FROM public.stock_quants q
      JOIN public.stock_locations l ON l.id = q.location_id
      JOIN public.warehouses w ON w.id = l.warehouse_id
     WHERE (_business_id IS NULL OR w.business_id = _business_id)
       AND public.user_can_access_business(auth.uid(), w.business_id)
     GROUP BY l.warehouse_id, q.product_id
  ),
  quant_by_lot AS (
    SELECT l.warehouse_id AS wh, q.product_id AS pid, q.lot_number AS lot, SUM(q.quantity) AS qty
      FROM public.stock_quants q
      JOIN public.stock_locations l ON l.id = q.location_id
      JOIN public.warehouses w ON w.id = l.warehouse_id
     WHERE q.lot_number IS NOT NULL
       AND (_business_id IS NULL OR w.business_id = _business_id)
       AND public.user_can_access_business(auth.uid(), w.business_id)
     GROUP BY l.warehouse_id, q.product_id, q.lot_number
  ),
  quant_by_product AS (
    SELECT q.product_id AS pid, SUM(q.quantity) AS qty
      FROM public.stock_quants q
      JOIN public.stock_locations l ON l.id = q.location_id
      JOIN public.warehouses w ON w.id = l.warehouse_id
     WHERE (_business_id IS NULL OR w.business_id = _business_id)
       AND public.user_can_access_business(auth.uid(), w.business_id)
     GROUP BY q.product_id
  ),
  lot_projection AS (
    SELECT wsl.warehouse_id AS wh, wsl.product_id AS pid,
           sl.lot_number AS lot, SUM(wsl.quantity) AS qty,
           w.business_id AS biz
      FROM public.warehouse_stock_lots wsl
      JOIN public.stock_lots sl ON sl.id = wsl.lot_id
      JOIN public.warehouses w ON w.id = wsl.warehouse_id
     GROUP BY wsl.warehouse_id, wsl.product_id, sl.lot_number, w.business_id
  ),
  mixed_scope AS (
    SELECT l.warehouse_id AS wh, q.product_id AS pid, q.location_id AS loc,
           COALESCE(q.lot_number,'') AS lot,
           SUM(q.quantity) FILTER (WHERE q.lpn_id IS NOT NULL) AS plate_qty,
           SUM(q.quantity) FILTER (WHERE q.lpn_id IS NULL)     AS loose_qty,
           w.business_id AS biz
      FROM public.stock_quants q
      JOIN public.stock_locations l ON l.id = q.location_id
      JOIN public.warehouses w ON w.id = l.warehouse_id
     WHERE q.quantity > 0
       AND (_business_id IS NULL OR w.business_id = _business_id)
       AND public.user_can_access_business(auth.uid(), w.business_id)
     GROUP BY l.warehouse_id, q.product_id, q.location_id, COALESCE(q.lot_number,''), w.business_id
  )
  SELECT 'warehouse_stock'::text, ws.warehouse_id, ws.product_id, NULL::text,
         COALESCE(qw.qty, 0), ws.quantity, COALESCE(qw.qty, 0) - ws.quantity
    FROM public.warehouse_stock ws
    JOIN public.warehouses w ON w.id = ws.warehouse_id
    LEFT JOIN quant_by_wh qw ON qw.wh = ws.warehouse_id AND qw.pid = ws.product_id
   WHERE (_business_id IS NULL OR w.business_id = _business_id)
     AND public.user_can_access_business(auth.uid(), w.business_id)
     AND COALESCE(qw.qty, 0) <> ws.quantity

  UNION ALL
  SELECT 'warehouse_stock_lots'::text, lp.wh, lp.pid, lp.lot,
         COALESCE(ql.qty, 0), lp.qty, COALESCE(ql.qty, 0) - lp.qty
    FROM lot_projection lp
    LEFT JOIN quant_by_lot ql
      ON ql.wh = lp.wh AND ql.pid = lp.pid AND ql.lot = lp.lot
   WHERE (_business_id IS NULL OR lp.biz = _business_id)
     AND public.user_can_access_business(auth.uid(), lp.biz)
     AND COALESCE(ql.qty, 0) <> lp.qty

  UNION ALL
  SELECT 'products.stock_quantity'::text, NULL::uuid, p.id, NULL::text,
         COALESCE(qp.qty, 0), COALESCE(p.stock_quantity, 0),
         COALESCE(qp.qty, 0) - COALESCE(p.stock_quantity, 0)
    FROM public.products p
    LEFT JOIN quant_by_product qp ON qp.pid = p.id
   WHERE (_business_id IS NULL OR p.business_id = _business_id)
     AND public.user_can_access_business(auth.uid(), p.business_id)
     AND COALESCE(qp.qty, 0) <> COALESCE(p.stock_quantity, 0)

  UNION ALL
  -- P2-2: the same (product, location, lot) balance counted both on a plate
  -- and loose at that location. Legitimate in a storage bin, but the classic
  -- double-count signature when the two figures are equal.
  SELECT 'stock_quants.mixed_scope'::text, ms.wh, ms.pid, NULLIF(ms.lot,''),
         ms.plate_qty + ms.loose_qty, ms.plate_qty,
         ms.loose_qty
    FROM mixed_scope ms
   WHERE ms.plate_qty > 0 AND ms.loose_qty > 0
$function$;

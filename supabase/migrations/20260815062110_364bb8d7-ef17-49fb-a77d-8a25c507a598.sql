CREATE OR REPLACE FUNCTION public.create_goods_receipt(_business_id uuid, _po_id uuid, _lines jsonb, _actor uuid, _warehouse_id uuid DEFAULT NULL::uuid, _receipt_number text DEFAULT NULL::text, _receipt_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gr_id     uuid;
  v_org_id    uuid;
  v_branch_id uuid;
  v_wh_id     uuid := _warehouse_id;
  v_number    text := _receipt_number;
  v_po        RECORD;
  v_line      jsonb;
  v_sort      int := 0;
  v_complete  jsonb;
BEGIN
  IF _business_id IS NULL OR _po_id IS NULL OR _actor IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'business_id, po_id and actor are required');
  END IF;
  IF _lines IS NULL OR jsonb_array_length(_lines) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'At least one receipt line is required');
  END IF;

  SELECT id, organization_id, business_id, deliver_to_warehouse_id AS warehouse_id, branch_id, po_number
    INTO v_po FROM public.purchase_orders WHERE id = _po_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Purchase order not found');
  END IF;
  IF v_po.business_id <> _business_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'PO does not belong to business');
  END IF;

  v_org_id    := v_po.organization_id;
  v_branch_id := v_po.branch_id;
  v_wh_id     := COALESCE(v_wh_id, v_po.warehouse_id);
  IF v_wh_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'No warehouse specified for goods receipt');
  END IF;

  IF v_number IS NULL THEN
    v_number := 'GRN-' || to_char(now(),'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 8);
  END IF;

  INSERT INTO public.goods_receipts (
    organization_id, business_id, branch_id, warehouse_id,
    purchase_order_id, receipt_number, receipt_date, received_by, status
  ) VALUES (
    v_org_id, _business_id, v_branch_id, v_wh_id,
    _po_id, v_number, COALESCE(_receipt_date, CURRENT_DATE), _actor, 'draft'
  )
  RETURNING id INTO v_gr_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    v_sort := v_sort + 1;
    INSERT INTO public.goods_receipt_items (
      goods_receipt_id, purchase_order_item_id, product_id,
      description, quantity_ordered, quantity_received,
      lot_number, serial_number, notes, sort_order, branch_id,
      packaging_id, display_uom_id, display_quantity,
      uom_snapshot, uom_snapshot_pack_name, uom_snapshot_factor, uom_snapshot_base_code
    )
    SELECT
      v_gr_id,
      (v_line->>'purchase_order_item_id')::uuid,
      COALESCE((v_line->>'product_id')::uuid, poi.product_id),
      COALESCE(v_line->>'description', poi.description),
      COALESCE(poi.quantity, 0),
      COALESCE((v_line->>'quantity_received')::numeric, 0),
      NULLIF(v_line->>'lot_number',''),
      NULLIF(v_line->>'serial_number',''),
      NULLIF(v_line->>'notes',''),
      v_sort,
      v_branch_id,
      v_pack.packaging_id,
      COALESCE(NULLIF(v_line->>'display_uom_id','')::uuid, poi.display_uom_id),
      CASE
        WHEN NULLIF(v_line->>'display_quantity','') IS NOT NULL
          THEN (v_line->>'display_quantity')::numeric
        WHEN v_pack.factor IS NOT NULL AND v_pack.factor > 0
          THEN COALESCE((v_line->>'quantity_received')::numeric, 0) / v_pack.factor
        ELSE COALESCE((v_line->>'quantity_received')::numeric, 0)
      END,
      poi.uom_snapshot,
      COALESCE(v_pack.pack_name, poi.uom_snapshot_pack_name),
      COALESCE(v_pack.factor, poi.uom_snapshot_factor),
      poi.uom_snapshot_base_code
      FROM public.purchase_order_items poi
      LEFT JOIN LATERAL (
        SELECT pk.id AS packaging_id, pk.name AS pack_name, pk.qty_in_base_uom AS factor
          FROM public.product_packaging pk
         WHERE pk.id = COALESCE(NULLIF(v_line->>'packaging_id','')::uuid, poi.packaging_id)
      ) v_pack ON true
     WHERE poi.id = (v_line->>'purchase_order_item_id')::uuid;
  END LOOP;

  v_complete := public.complete_goods_receipt_atomic(v_gr_id, _actor);
  IF NOT COALESCE((v_complete->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'complete_goods_receipt_atomic failed: %', v_complete->>'error';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'goods_receipt_id', v_gr_id,
    'receipt_number',  v_number,
    'movement_count',  v_complete->'movement_count',
    'journal_id',      v_complete->'journal_id'
  );
END; $function$;
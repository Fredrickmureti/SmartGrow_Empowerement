-- P0-1: receive_goods_to_wms added a plate-scoped quant without relieving the
-- location-scoped one whenever staging == the warehouse default location,
-- double-counting every such receipt. Relocation must always relieve.
CREATE OR REPLACE FUNCTION public.receive_goods_to_wms(
  p_goods_receipt_id uuid,
  p_staging_location_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
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
BEGIN
  SELECT id, organization_id, business_id, branch_id, warehouse_id
    INTO v_gr
  FROM public.goods_receipts
  WHERE id = p_goods_receipt_id;
  IF v_gr.id IS NULL THEN RAISE EXCEPTION 'goods_receipt % not found', p_goods_receipt_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_gr.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;

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
      v_lpn_code, 'pallet', 'open', p_staging_location_id, auth.uid()
    ) RETURNING id INTO v_lpn_id;
    v_created_plates := v_created_plates + 1;

    -- The goods receipt ledger already created the balance at the warehouse
    -- default location. Staging RELOCATES it — it must never add stock again.
    -- This relief is unconditional: when staging IS the default location the
    -- balance simply moves from the loose location quant onto the plate.
    -- package_id is the commercial packaging level (product_packaging);
    -- the physical container belongs in lpn_id.
    IF v_default_location IS NOT NULL THEN
      UPDATE public.stock_quants
         SET quantity = quantity - v_line.quantity_received,
             updated_at = now()
       WHERE product_id  = v_line.product_id
         AND location_id = v_default_location
         AND COALESCE(lot_number,'') = COALESCE(v_line.lot_number,'')
         AND package_id IS NULL
         AND lpn_id IS NULL;
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
      auth.uid()
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
$fn$;
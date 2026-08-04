
DROP FUNCTION IF EXISTS public.suggest_putaway_locations(uuid, uuid, numeric);

CREATE OR REPLACE FUNCTION public.suggest_putaway_locations(
  p_warehouse_id uuid,
  p_product_id uuid,
  p_quantity numeric,
  p_lot_number text DEFAULT NULL
)
RETURNS TABLE(location_id uuid, rank integer, strategy text, reason text, feasible_qty numeric, score numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_business uuid;
  v_category uuid;
  v_prof public.wms_product_storage_profiles%ROWTYPE;
  v_expiry boolean := false;
BEGIN
  SELECT business_id INTO v_business FROM public.warehouses WHERE id = p_warehouse_id;
  IF v_business IS NULL OR NOT user_can_access_business(auth.uid(), v_business) THEN
    RETURN;
  END IF;

  SELECT category_id, COALESCE(is_expiry_tracked,false) INTO v_category, v_expiry
    FROM public.products WHERE id = p_product_id;
  SELECT * INTO v_prof FROM public.wms_product_storage_profiles WHERE product_id = p_product_id;

  RETURN QUERY
  WITH strat AS (
    SELECT s.strategy_type, s.sequence, s.params
    FROM public.wms_putaway_strategies s
    WHERE s.business_id = v_business
      AND (s.warehouse_id = p_warehouse_id OR s.warehouse_id IS NULL)
      AND s.is_active
  ),
  base AS (
    SELECT sl.*
    FROM public.stock_locations sl
    WHERE sl.warehouse_id = p_warehouse_id
      AND sl.is_active
      AND COALESCE(sl.is_putaway_target, false)
      AND COALESCE(sl.is_receiving_staging, false) = false
      AND COALESCE(sl.is_blocked, false) = false
  ),
  zone_desc AS (
    -- descendants of every slotting-rule target zone that matches this product
    WITH RECURSIVE roots AS (
      SELECT r.target_zone_id AS zone_id
      FROM public.wms_slotting_rules r
      WHERE r.is_active
        AND r.business_id = v_business
        AND r.warehouse_id = p_warehouse_id
        AND r.target_zone_id IS NOT NULL
        AND (r.velocity_class IS NULL OR r.velocity_class = v_prof.velocity_class)
        AND (r.is_hazmat IS NOT TRUE OR v_prof.hazmat_class IS NOT NULL)
        AND (r.requires_temp_control IS NOT TRUE
             OR COALESCE(v_prof.temp_regime,'ambient') <> 'ambient')
        AND (r.max_weight_kg IS NULL OR COALESCE(v_prof.unit_weight, 0) <= r.max_weight_kg)
    ),
    walk AS (
      SELECT zone_id AS id FROM roots
      UNION
      SELECT sl.id FROM public.stock_locations sl JOIN walk w ON sl.parent_location_id = w.id
    )
    SELECT id FROM walk
  ),
  cand AS (
    -- fixed bin
    SELECT b.id AS lid, st.sequence, 'fixed_bin'::text AS strat, 'product fixed bin'::text AS why,
           fb.priority::numeric AS tiebreak
    FROM strat st
    JOIN public.wms_product_fixed_bins fb
      ON fb.warehouse_id = p_warehouse_id AND fb.product_id = p_product_id AND fb.is_active
    JOIN base b ON b.id = fb.location_id
    WHERE st.strategy_type = 'fixed_bin'

    UNION ALL
    -- cold chain
    SELECT b.id, st.sequence, 'cold_chain', 'temperature-controlled zone', 0
    FROM strat st JOIN base b ON b.temp_regime = v_prof.temp_regime
    WHERE st.strategy_type = 'cold_chain'
      AND COALESCE(v_prof.temp_regime,'ambient') <> 'ambient'

    UNION ALL
    -- hazmat
    SELECT b.id, st.sequence, 'hazmat_zone', 'hazard class permitted', 0
    FROM strat st JOIN base b ON v_prof.hazmat_class = ANY (b.hazmat_classes)
    WHERE st.strategy_type = 'hazmat_zone' AND v_prof.hazmat_class IS NOT NULL

    UNION ALL
    -- heavy items → ground level
    SELECT b.id, st.sequence, 'heavy_zone', 'heavy item on ground level', 0
    FROM strat st JOIN base b ON COALESCE(b.ground_level,false)
    WHERE st.strategy_type = 'heavy_zone'
      AND COALESCE(v_prof.unit_weight,0) >= COALESCE((st.params->>'heavy_kg')::numeric, 25)

    UNION ALL
    -- consolidate same product
    SELECT b.id, st.sequence, 'consolidate', 'consolidate same product', 0
    FROM strat st JOIN base b ON EXISTS (
      SELECT 1 FROM public.stock_quants q
      WHERE q.location_id = b.id AND q.product_id = p_product_id AND COALESCE(q.quantity,0) > 0)
    WHERE st.strategy_type = 'consolidate'

    UNION ALL
    -- FEFO zone for expiry-tracked goods
    SELECT b.id, st.sequence, 'fefo_zone', 'expiry-managed zone', 0
    FROM strat st JOIN base b ON b.storage_role = 'fefo'
    WHERE st.strategy_type = 'fefo_zone' AND v_expiry

    UNION ALL
    -- velocity slotting via slotting rules
    SELECT b.id, st.sequence, 'velocity_slot', 'velocity slotting rule', 0
    FROM strat st JOIN base b ON b.id IN (SELECT id FROM zone_desc)
    WHERE st.strategy_type = 'velocity_slot'

    UNION ALL
    -- same category
    SELECT b.id, st.sequence, 'same_category', 'same category neighbours', 0
    FROM strat st JOIN base b ON EXISTS (
      SELECT 1 FROM public.stock_quants q
      JOIN public.products p ON p.id = q.product_id AND p.category_id = v_category
      WHERE q.location_id = b.id AND COALESCE(q.quantity,0) > 0)
    WHERE st.strategy_type = 'same_category' AND v_category IS NOT NULL

    UNION ALL
    -- empty bin
    SELECT b.id, st.sequence, 'empty_bin', 'empty bin', COALESCE(b.pick_sequence,0)
    FROM strat st JOIN base b ON NOT EXISTS (
      SELECT 1 FROM public.stock_quants q WHERE q.location_id = b.id AND COALESCE(q.quantity,0) > 0)
    WHERE st.strategy_type = 'empty_bin'

    UNION ALL
    -- nearest by pick sequence
    SELECT b.id, st.sequence, 'nearest', 'nearest by travel sequence', COALESCE(b.pick_sequence,0)
    FROM strat st JOIN base b ON true
    WHERE st.strategy_type = 'nearest'

    UNION ALL
    -- bulk
    SELECT b.id, st.sequence, 'bulk', 'bulk storage area', 0
    FROM strat st JOIN base b ON b.storage_role = 'bulk'
    WHERE st.strategy_type = 'bulk'

    UNION ALL
    -- overflow
    SELECT b.id, st.sequence, 'overflow', 'overflow area', 0
    FROM strat st JOIN base b ON b.storage_role = 'overflow'
    WHERE st.strategy_type = 'overflow'

    UNION ALL
    -- general priority fallback
    SELECT b.id, st.sequence, 'general_priority', 'general putaway priority',
           -COALESCE(b.putaway_priority,0)
    FROM strat st JOIN base b ON true
    WHERE st.strategy_type = 'general_priority'
  ),
  best AS (
    SELECT DISTINCT ON (c.lid) c.lid, c.sequence, c.strat, c.why, c.tiebreak
    FROM cand c
    ORDER BY c.lid, c.sequence, c.tiebreak
  ),
  checked AS (
    SELECT b.*, f.feasible, f.reason AS fit_reason, f.qty AS fit_qty
    FROM best b
    CROSS JOIN LATERAL (
      SELECT (j->>'feasible')::boolean AS feasible,
             j->>'reason' AS reason,
             COALESCE((j->>'feasible_qty')::numeric, 0) AS qty
      FROM public.wms_location_feasible(b.lid, p_product_id, p_quantity, p_lot_number) j
    ) f
    WHERE f.feasible
  )
  SELECT c.lid,
         ROW_NUMBER() OVER (ORDER BY c.sequence, c.tiebreak, c.lid)::int,
         c.strat,
         CASE WHEN c.fit_reason = 'partial_capacity' THEN c.why || ' (partial)' ELSE c.why END,
         c.fit_qty,
         (1000 - c.sequence)::numeric
  FROM checked c
  ORDER BY c.sequence, c.tiebreak, c.lid;
END;
$function$;

REVOKE ALL ON FUNCTION public.suggest_putaway_locations(uuid, uuid, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.suggest_putaway_locations(uuid, uuid, numeric, text) TO authenticated, service_role;

-- Receiving records strategy provenance on each suggestion
CREATE OR REPLACE FUNCTION public.receive_goods_to_wms(p_goods_receipt_id uuid, p_staging_location_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
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

  PERFORM public.wms_ensure_default_putaway_strategies(v_gr.warehouse_id);

  FOR v_line IN
    SELECT gri.id AS line_id, gri.product_id, gri.quantity_received, gri.lot_number
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

    INSERT INTO public.stock_quants (
      organization_id, business_id, branch_id,
      product_id, location_id, lot_number, package_id, quantity
    ) VALUES (
      v_gr.organization_id, v_gr.business_id, v_gr.branch_id,
      v_line.product_id, p_staging_location_id, v_line.lot_number, v_lpn_id, v_line.quantity_received
    );

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
      SELECT * FROM public.suggest_putaway_locations(
        v_gr.warehouse_id, v_line.product_id, v_line.quantity_received, v_line.lot_number)
      LIMIT 5
    LOOP
      v_sug_rank := v_sug_rank + 1;
      INSERT INTO public.wms_putaway_suggestions (
        organization_id, business_id, branch_id,
        task_id, location_id, rank, reason, chosen, strategy, feasible_qty, score
      ) VALUES (
        v_gr.organization_id, v_gr.business_id, v_gr.branch_id,
        v_task_id, v_suggestion.location_id, v_sug_rank, v_suggestion.reason,
        v_sug_rank = 1, v_suggestion.strategy, v_suggestion.feasible_qty, v_suggestion.score
      );
      IF v_sug_rank = 1 THEN v_dest_id := v_suggestion.location_id; END IF;
    END LOOP;

    IF v_dest_id IS NOT NULL THEN
      UPDATE public.wms_tasks SET destination_location_id = v_dest_id WHERE id = v_task_id;
    END IF;
  END LOOP;

  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, warehouse_id, event_type,
      source_doc_type, source_doc_id, payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_gr.organization_id, v_gr.branch_id, v_gr.warehouse_id,
      'warehouse.receipt.staged',
      'goods_receipt', p_goods_receipt_id,
      jsonb_build_object(
        'goods_receipt_id', p_goods_receipt_id,
        'business_id', v_gr.business_id,
        'staging_location_id', p_staging_location_id,
        'lpns_created', v_created_plates,
        'tasks_created', v_created_tasks,
        'task_ids', to_jsonb(v_task_ids)
      ),
      'wms.receipt.staged:' || p_goods_receipt_id::text || ':' || v_created_tasks::text,
      'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wms outbox emit failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'goods_receipt_id', p_goods_receipt_id,
    'lpns_created', v_created_plates,
    'tasks_created', v_created_tasks,
    'task_ids', to_jsonb(v_task_ids)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.suggest_putaway_locations(p_warehouse_id uuid, p_product_id uuid, p_quantity numeric, p_lot_number text DEFAULT NULL::text)
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
    SELECT b.id AS lid, st.sequence, 'fixed_bin'::text AS strat, 'product fixed bin'::text AS why,
           fb.priority::numeric AS tiebreak
    FROM strat st
    JOIN public.wms_product_fixed_bins fb
      ON fb.warehouse_id = p_warehouse_id AND fb.product_id = p_product_id AND fb.is_active
    JOIN base b ON b.id = fb.location_id
    WHERE st.strategy_type = 'fixed_bin'

    UNION ALL
    SELECT b.id, st.sequence, 'cold_chain', 'temperature-controlled zone', 0
    FROM strat st JOIN base b ON b.temp_regime = v_prof.temp_regime
    WHERE st.strategy_type = 'cold_chain'
      AND COALESCE(v_prof.temp_regime,'ambient') <> 'ambient'

    UNION ALL
    SELECT b.id, st.sequence, 'hazmat_zone', 'hazard class permitted', 0
    FROM strat st JOIN base b ON v_prof.hazmat_class = ANY (b.hazmat_classes)
    WHERE st.strategy_type = 'hazmat_zone' AND v_prof.hazmat_class IS NOT NULL

    UNION ALL
    SELECT b.id, st.sequence, 'heavy_zone', 'heavy item on ground level', 0
    FROM strat st JOIN base b ON COALESCE(b.ground_level,false)
    WHERE st.strategy_type = 'heavy_zone'
      AND COALESCE(v_prof.unit_weight,0) >= COALESCE((st.params->>'heavy_kg')::numeric, 25)

    UNION ALL
    SELECT b.id, st.sequence, 'consolidate', 'consolidate same product', 0
    FROM strat st JOIN base b ON EXISTS (
      SELECT 1 FROM public.stock_quants q
      WHERE q.location_id = b.id AND q.product_id = p_product_id AND COALESCE(q.quantity,0) > 0)
    WHERE st.strategy_type = 'consolidate'

    UNION ALL
    SELECT b.id, st.sequence, 'fefo_zone', 'expiry-managed zone', 0
    FROM strat st JOIN base b ON b.storage_role = 'fefo'
    WHERE st.strategy_type = 'fefo_zone' AND v_expiry

    UNION ALL
    SELECT b.id, st.sequence, 'velocity_slot', 'velocity slotting rule', 0
    FROM strat st JOIN base b ON b.id IN (SELECT id FROM zone_desc)
    WHERE st.strategy_type = 'velocity_slot'

    UNION ALL
    SELECT b.id, st.sequence, 'same_category', 'same category neighbours', 0
    FROM strat st JOIN base b ON EXISTS (
      SELECT 1 FROM public.stock_quants q
      JOIN public.products p ON p.id = q.product_id AND p.category_id = v_category
      WHERE q.location_id = b.id AND COALESCE(q.quantity,0) > 0)
    WHERE st.strategy_type = 'same_category' AND v_category IS NOT NULL

    UNION ALL
    SELECT b.id, st.sequence, 'empty_bin', 'empty bin', COALESCE(b.pick_sequence,0)
    FROM strat st JOIN base b ON NOT EXISTS (
      SELECT 1 FROM public.stock_quants q WHERE q.location_id = b.id AND COALESCE(q.quantity,0) > 0)
    WHERE st.strategy_type = 'empty_bin'

    UNION ALL
    SELECT b.id, st.sequence, 'nearest', 'nearest by travel sequence', COALESCE(b.pick_sequence,0)
    FROM strat st JOIN base b ON true
    WHERE st.strategy_type = 'nearest'

    UNION ALL
    SELECT b.id, st.sequence, 'bulk', 'bulk storage area', 0
    FROM strat st JOIN base b ON b.storage_role = 'bulk'
    WHERE st.strategy_type = 'bulk'

    UNION ALL
    SELECT b.id, st.sequence, 'overflow', 'overflow area', 0
    FROM strat st JOIN base b ON b.storage_role = 'overflow'
    WHERE st.strategy_type = 'overflow'

    UNION ALL
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
  -- A bin that can take the WHOLE quantity always outranks a partial-fit bin:
  -- complete_putaway_task rejects a destination that cannot hold the full task
  -- quantity, so a partial-fit suggestion is an instruction that cannot be executed.
  SELECT c.lid,
         ROW_NUMBER() OVER (
           ORDER BY (c.fit_qty >= p_quantity) DESC, c.sequence, c.tiebreak, c.lid)::int,
         c.strat,
         CASE WHEN c.fit_reason = 'partial_capacity' THEN c.why || ' (partial)' ELSE c.why END,
         c.fit_qty,
         (1000 - c.sequence + CASE WHEN c.fit_qty >= p_quantity THEN 1000 ELSE 0 END)::numeric
  FROM checked c
  ORDER BY (c.fit_qty >= p_quantity) DESC, c.sequence, c.tiebreak, c.lid;
END;
$function$;

DO $sim$
DECLARE
  c_wh   uuid := '62853bd5-96be-4d9d-983c-67bb4f154775';
  c_user uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  v_prod uuid; v_rv int; v_j jsonb; v_task record; v_dest uuid;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', c_user, 'role', 'authenticated')::text, true);
  SELECT id INTO v_prod FROM products WHERE sku='E2E-MILK-500' LIMIT 1;

  FOR v_task IN
    SELECT * FROM wms_tasks
     WHERE task_type='putaway' AND warehouse_id=c_wh
       AND state IN ('pending','available','claimed','in_progress')
     ORDER BY created_at
  LOOP
    BEGIN
      SELECT location_id INTO v_dest
        FROM suggest_putaway_locations(c_wh, v_task.product_id, v_task.quantity, v_task.lot_number)
       ORDER BY rank LIMIT 1;
      IF v_dest IS DISTINCT FROM v_task.destination_location_id AND v_dest IS NOT NULL THEN
        SELECT row_version INTO v_rv FROM wms_tasks WHERE id=v_task.id;
        PERFORM wms_reassign_putaway_task(v_task.id, v_rv, v_dest, 'full-fit bin selected');
      END IF;
      v_j := complete_putaway_task(v_task.id, v_dest, NULL);
      INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R5_01_putaway','ok',
        jsonb_build_object('task',v_task.id,'qty',v_task.quantity,'rpc',v_j,
          'dest_code',(SELECT code FROM stock_locations WHERE id=v_dest)));
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R5_01_putaway','error',
        jsonb_build_object('task',v_task.id,'err',SQLERRM,'code',SQLSTATE));
    END;
  END LOOP;

  INSERT INTO _e2e_milk_log(step,status,detail) VALUES ('R5_02_recon','ok',
    jsonb_build_object(
      'movements_net',(SELECT COALESCE(SUM(quantity),0) FROM stock_movements WHERE product_id=v_prod),
      'quants',(SELECT jsonb_agg(jsonb_build_object('loc',(SELECT code FROM stock_locations l WHERE l.id=q.location_id),
        'lpn',q.lpn_id IS NOT NULL,'qty',q.quantity)) FROM stock_quants q WHERE q.product_id=v_prod AND q.quantity <> 0),
      'products_stock_quantity',(SELECT stock_quantity FROM products WHERE id=v_prod),
      'open_putaway',(SELECT count(*) FROM wms_tasks WHERE task_type='putaway'
        AND state IN ('pending','available','claimed','in_progress')),
      'open_sessions',(SELECT jsonb_agg(jsonb_build_object('code',code,'state',state))
        FROM wms_receiving_sessions WHERE state NOT IN ('closed','cancelled'))));
END $sim$;
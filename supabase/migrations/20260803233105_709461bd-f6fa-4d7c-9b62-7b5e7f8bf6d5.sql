-- Cross-dock Phase 6 — replenishment demand coverage + routing label.
-- Production demand deliberately not covered: no work-order tables exist yet.

CREATE OR REPLACE FUNCTION public._wms_crossdock_detect(
  p_business_id       uuid,
  p_warehouse_id      uuid,
  p_product_id        uuid,
  p_quantity          numeric,
  p_grn_id            uuid DEFAULT NULL,
  p_grn_line_id       uuid DEFAULT NULL,
  p_receiving_line_id uuid DEFAULT NULL,
  p_lot_number        text DEFAULT NULL,
  p_expiry_date       date DEFAULT NULL,
  p_qc_hold           boolean DEFAULT false
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_wh        public.warehouses;
  v_rule      public.wms_crossdock_rules;
  v_prod      public.products;
  v_remaining numeric := COALESCE(p_quantity, 0);
  v_cand      record;
  v_row       public.wms_crossdock_opportunities;
  v_alloc     numeric;
  v_score     numeric;
  v_hours     numeric;
  v_reject    text;
  v_state     public.wms_crossdock_state;
  v_count     int := 0;
BEGIN
  IF v_remaining <= 0 OR p_product_id IS NULL OR p_warehouse_id IS NULL THEN RETURN 0; END IF;

  SELECT * INTO v_wh FROM public.warehouses WHERE id = p_warehouse_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  SELECT * INTO v_prod FROM public.products WHERE id = p_product_id;
  v_rule := public._wms_crossdock_resolve_rule(p_business_id, p_warehouse_id);

  v_reject := NULL;
  IF p_qc_hold AND COALESCE(v_rule.require_qc_pass, true) THEN
    v_reject := 'QC hold open on receipt line';
  ELSIF v_prod.is_serial_tracked AND NOT COALESCE(v_rule.allow_serial_tracked, false) THEN
    v_reject := 'Serial-tracked product excluded by policy';
  ELSIF v_prod.is_lot_tracked AND NOT COALESCE(v_rule.allow_lot_tracked, true) THEN
    v_reject := 'Lot-tracked product excluded by policy';
  ELSIF v_rule.min_shelf_life_days IS NOT NULL AND p_expiry_date IS NOT NULL
        AND (p_expiry_date - CURRENT_DATE) < v_rule.min_shelf_life_days THEN
    v_reject := format('Shelf life %s days below policy minimum %s',
                       (p_expiry_date - CURRENT_DATE), v_rule.min_shelf_life_days);
  ELSIF v_remaining < COALESCE(v_rule.min_quantity, 0) THEN
    v_reject := 'Quantity below policy minimum';
  ELSIF v_rule.max_quantity IS NOT NULL AND v_remaining > v_rule.max_quantity THEN
    v_reject := 'Quantity above policy maximum';
  END IF;

  -- candidate demand: sales orders + outbound transfers + pick-face replenishment
  FOR v_cand IN
    WITH demand AS (
      SELECT 'sales_order'::public.wms_crossdock_demand_type AS demand_type,
             so.id AS doc_id, soi.id AS line_id, so.branch_id AS branch_id,
             (COALESCE(soi.quantity,0) - COALESCE(soi.quantity_fulfilled,0)) AS open_qty,
             COALESCE(so.expected_date::timestamptz, so.order_date::timestamptz + interval '48 hours') AS cutoff,
             so.order_date::timestamptz AS ordered_at,
             NULL::uuid AS destination_location_id
        FROM public.sales_order_items soi
        JOIN public.sales_orders so ON so.id = soi.sales_order_id
       WHERE so.business_id = p_business_id
         AND soi.product_id = p_product_id
         AND so.status IN ('confirmed','processing','partial')
         AND (COALESCE(soi.quantity,0) - COALESCE(soi.quantity_fulfilled,0)) > 0
      UNION ALL
      SELECT 'transfer'::public.wms_crossdock_demand_type,
             st.id, sti.id, st.from_branch_id,
             (COALESCE(sti.quantity_requested,0) - COALESCE(sti.quantity_sent,0)),
             COALESCE(st.expected_arrival_date::timestamptz, st.transfer_date::timestamptz + interval '48 hours'),
             st.transfer_date::timestamptz,
             NULL::uuid
        FROM public.stock_transfer_items sti
        JOIN public.stock_transfers st ON st.id = sti.transfer_id
       WHERE st.business_id = p_business_id
         AND st.from_warehouse_id = p_warehouse_id
         AND sti.product_id = p_product_id
         AND st.status IN ('pending','approved','in_transit_pending','draft')
         AND (COALESCE(sti.quantity_requested,0) - COALESCE(sti.quantity_sent,0)) > 0
      UNION ALL
      -- Pick-face top-up: freight can go straight to the pick location.
      SELECT 'replenishment'::public.wms_crossdock_demand_type,
             ro.id, ro.id, ro.branch_id,
             (COALESCE(ro.requested_qty,0) - COALESCE(ro.moved_qty,0)),
             COALESCE(ro.due_at, ro.created_at + interval '8 hours'),
             ro.created_at,
             ro.pick_location_id
        FROM public.wms_replen_orders ro
       WHERE ro.business_id = p_business_id
         AND ro.warehouse_id = p_warehouse_id
         AND ro.product_id = p_product_id
         AND ro.state IN ('pending','ready','dispatched','assigned')
         AND (COALESCE(ro.requested_qty,0) - COALESCE(ro.moved_qty,0)) > 0
    )
    SELECT d.*
      FROM demand d
     WHERE NOT EXISTS (
       SELECT 1 FROM public.wms_crossdock_opportunities x
        WHERE x.business_id = p_business_id
          AND x.demand_line_id = d.line_id
          AND ((p_grn_line_id IS NOT NULL AND x.grn_line_id = p_grn_line_id)
            OR (p_receiving_line_id IS NOT NULL AND x.receiving_line_id = p_receiving_line_id))
     )
     ORDER BY d.cutoff ASC, d.ordered_at ASC
     LIMIT 25
  LOOP
    EXIT WHEN v_remaining <= 0;

    v_alloc := LEAST(v_remaining, v_cand.open_qty);
    v_hours := EXTRACT(EPOCH FROM (v_cand.cutoff - now())) / 3600.0;

    v_score := GREATEST(0, LEAST(50, 50 - (v_hours / 2)))
             + LEAST(30, 30 * (v_alloc / NULLIF(v_cand.open_qty, 0)))
             + CASE WHEN v_alloc >= v_cand.open_qty THEN 20 ELSE 0 END;

    IF v_reject IS NOT NULL THEN
      v_state := 'rejected';
    ELSIF v_hours < COALESCE(v_rule.min_hours_to_cutoff, 0) THEN
      v_state := 'rejected';
    ELSIF v_hours > COALESCE(v_rule.max_hours_to_cutoff, 1e6) THEN
      v_state := 'rejected';
    ELSIF COALESCE(v_rule.require_full_line, false) AND v_alloc < v_cand.open_qty THEN
      v_state := 'rejected';
    ELSIF v_rule.auto_approve_score IS NOT NULL AND v_score >= v_rule.auto_approve_score THEN
      v_state := 'approved';
    ELSE
      v_state := 'qualified';
    END IF;

    INSERT INTO public.wms_crossdock_opportunities (
      business_id, organization_id, branch_id, warehouse_id,
      grn_id, grn_line_id, receiving_line_id,
      product_id, quantity,
      demand_type, demand_doc_id, demand_line_id,
      sales_order_id, sales_order_item_id,
      state, score, rule_id, expires_at, qualified_at,
      reject_reason, approved_at, staging_location_id
    ) VALUES (
      p_business_id, v_wh.organization_id, COALESCE(v_wh.branch_id, v_cand.branch_id), p_warehouse_id,
      p_grn_id, p_grn_line_id, p_receiving_line_id,
      p_product_id, v_alloc,
      v_cand.demand_type, v_cand.doc_id, v_cand.line_id,
      CASE WHEN v_cand.demand_type = 'sales_order' THEN v_cand.doc_id END,
      CASE WHEN v_cand.demand_type = 'sales_order' THEN v_cand.line_id END,
      v_state, ROUND(v_score, 2), v_rule.id, v_cand.cutoff, now(),
      CASE WHEN v_state = 'rejected'
           THEN COALESCE(v_reject,
                  CASE WHEN v_hours < COALESCE(v_rule.min_hours_to_cutoff,0) THEN 'Past cut-off window'
                       WHEN v_hours > COALESCE(v_rule.max_hours_to_cutoff,1e6) THEN 'Demand too far in the future'
                       ELSE 'Partial fill not allowed by policy' END)
      END,
      CASE WHEN v_state = 'approved' THEN now() END,
      -- Replenishment flows to the pick face itself, not an outbound lane.
      v_cand.destination_location_id
    )
    ON CONFLICT DO NOTHING
    RETURNING * INTO v_row;

    IF v_row.id IS NOT NULL THEN
      PERFORM public.emit_crossdock_event(
        CASE v_row.state
          WHEN 'rejected' THEN 'warehouse.crossdock.rejected'
          WHEN 'approved' THEN 'warehouse.crossdock.approved'
          ELSE 'warehouse.crossdock.qualified'
        END, v_row);
      IF v_row.state <> 'rejected' THEN
        v_remaining := v_remaining - v_alloc;
      END IF;
      v_count := v_count + 1;
    END IF;
    v_row := NULL;
  END LOOP;

  RETURN v_count;
END $$;

-- Requalification sweep must understand replenishment demand too.
CREATE OR REPLACE FUNCTION public.wms_crossdock_requalify_sweep()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE r record; v_out numeric; v_count integer := 0;
BEGIN
  FOR r IN
    SELECT o.* FROM public.wms_crossdock_opportunities o
     WHERE o.state IN ('detected','qualified','approved','staging','staged')
  LOOP
    IF r.expires_at IS NOT NULL AND r.expires_at < now()
       AND r.state IN ('detected','qualified') THEN
      PERFORM public._wms_crossdock_auto_break(r.id, 'Carrier cut-off passed', 'expired');
      v_count := v_count + 1;
      CONTINUE;
    END IF;

    v_out := NULL;
    IF COALESCE(r.demand_type, 'sales_order') = 'sales_order' THEN
      SELECT GREATEST(COALESCE(si.quantity,0) - COALESCE(si.quantity_fulfilled,0), 0)
        INTO v_out
        FROM public.sales_order_items si
        JOIN public.sales_orders so ON so.id = si.sales_order_id
       WHERE si.id = COALESCE(r.demand_line_id, r.sales_order_item_id)
         AND so.status <> 'cancelled';
    ELSIF r.demand_type = 'transfer' THEN
      SELECT GREATEST(COALESCE(ti.quantity_requested,0) - COALESCE(ti.quantity_received,0), 0)
        INTO v_out
        FROM public.stock_transfer_items ti
        JOIN public.stock_transfers t ON t.id = ti.transfer_id
       WHERE ti.id = r.demand_line_id
         AND t.status <> 'cancelled';
    ELSIF r.demand_type = 'replenishment' THEN
      SELECT GREATEST(COALESCE(ro.requested_qty,0) - COALESCE(ro.moved_qty,0), 0)
        INTO v_out
        FROM public.wms_replen_orders ro
       WHERE ro.id = r.demand_line_id
         AND ro.state NOT IN ('cancelled','completed');
    END IF;

    IF v_out IS NULL THEN
      PERFORM public._wms_crossdock_auto_break(r.id, 'Demand document no longer available');
      v_count := v_count + 1;
    ELSIF v_out <= 0 THEN
      PERFORM public._wms_crossdock_auto_break(r.id, 'Demand already fulfilled elsewhere');
      v_count := v_count + 1;
    ELSIF v_out < r.quantity THEN
      PERFORM public._wms_crossdock_auto_break(r.id,
        format('Demand reduced to %s (plan was %s)', v_out, r.quantity));
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN v_count;
END $$;

-- Cross-dock routing label -------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_seed_crossdock_label_templates(
  _org_id uuid,
  _actor  uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_routing jsonb := jsonb_build_object(
    'version', 1,
    'elements', jsonb_build_array(
      jsonb_build_object('id','lbl','type','text',    'xMm', 4, 'yMm', 3,  'text','CROSS-DOCK — DO NOT PUT AWAY', 'fontSize', 3.5, 'bold', true),
      jsonb_build_object('id','prd','type','variable','xMm', 4, 'yMm', 11, 'token','product_name','fontSize', 4, 'bold', true),
      jsonb_build_object('id','sku','type','variable','xMm', 4, 'yMm', 18, 'token','product_sku','fontSize', 3),
      jsonb_build_object('id','qty','type','variable','xMm', 60,'yMm', 18, 'token','quantity','fontSize', 4, 'bold', true, 'prefix','Qty: '),
      jsonb_build_object('id','dst','type','variable','xMm', 4, 'yMm', 25, 'token','staging_code','fontSize', 4, 'bold', true, 'prefix','To: '),
      jsonb_build_object('id','dck','type','variable','xMm', 60,'yMm', 25, 'token','dock_code','fontSize', 3, 'prefix','Dock: '),
      jsonb_build_object('id','dem','type','variable','xMm', 4, 'yMm', 32, 'token','demand_number','fontSize', 3, 'prefix','For: '),
      jsonb_build_object('id','cus','type','variable','xMm', 4, 'yMm', 38, 'token','customer_name','fontSize', 3),
      jsonb_build_object('id','cut','type','variable','xMm', 60,'yMm', 38, 'token','cutoff_at','fontSize', 2.5, 'prefix','Cut-off: '),
      jsonb_build_object('id','bc', 'type','barcode', 'xMm', 4, 'yMm', 44, 'token','opportunity_code','symbology','code128','heightMm', 20, 'moduleMm', 0.4, 'hri', true)
    )
  );
BEGIN
  INSERT INTO public.label_templates
    (org_id, branch_id, kind, template_key, name, engine, body, body_json,
     geometry_mode, width_mm, height_mm, is_default, active, created_by)
  VALUES
    (_org_id, NULL, 'crossdock_routing', 'wms.label.crossdock_routing',
     'Cross-dock Routing (WMS)', 'zpl'::label_engine,
     '', v_routing, 'mm', 102, 76, true, true, _actor)
  ON CONFLICT (org_id, template_key, COALESCE(media_profile_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE branch_id IS NULL
  DO UPDATE SET
    body_json = EXCLUDED.body_json, engine = EXCLUDED.engine,
    geometry_mode = EXCLUDED.geometry_mode,
    width_mm = EXCLUDED.width_mm, height_mm = EXCLUDED.height_mm,
    name = EXCLUDED.name, is_default = true, active = true, updated_at = now();
END $fn$;

REVOKE ALL ON FUNCTION public.wms_seed_crossdock_label_templates(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_seed_crossdock_label_templates(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.wms_seed_default_label_templates(
  _org_id uuid,
  _actor  uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  PERFORM public.wms_seed_base_label_templates(_org_id, _actor);
  PERFORM public.wms_seed_receiving_label_templates(_org_id, _actor);
  PERFORM public.wms_seed_returns_label_templates(_org_id, _actor);
  PERFORM public.wms_seed_yard_label_templates(_org_id, _actor);
  PERFORM public.wms_seed_crossdock_label_templates(_org_id, _actor);
END $fn$;

REVOKE ALL ON FUNCTION public.wms_seed_default_label_templates(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_seed_default_label_templates(uuid, uuid) TO authenticated, service_role;

DO $backfill$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT org_id FROM public.label_templates WHERE template_key = 'wms.label.lpn'
  LOOP
    PERFORM public.wms_seed_crossdock_label_templates(r.org_id, NULL);
  END LOOP;
END $backfill$;
-- ============================================================
-- Cross-dock Phase 2 — qualification & allocation engine
-- ============================================================

-- Allow multi-demand splitting: one row per (receipt line, demand line)
ALTER TABLE public.wms_crossdock_opportunities
  DROP CONSTRAINT IF EXISTS wms_crossdock_opportunities_business_id_grn_line_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_wms_crossdock_grn_demand
  ON public.wms_crossdock_opportunities (business_id, grn_line_id, demand_line_id)
  WHERE grn_line_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_wms_crossdock_recv_demand
  ON public.wms_crossdock_opportunities (business_id, receiving_line_id, demand_line_id)
  WHERE receiving_line_id IS NOT NULL;

-- Seed a default rule per warehouse -----------------------------------
INSERT INTO public.wms_crossdock_rules (
  organization_id, business_id, warehouse_id, name, priority,
  min_shelf_life_days, min_quantity, max_hours_to_cutoff, min_hours_to_cutoff,
  auto_approve_score, notes
)
SELECT w.organization_id, w.business_id, w.id, 'Default cross-dock policy', 100,
       7, 1, 72, 0.5, 80,
       'Auto-seeded baseline policy. Tune per warehouse.'
  FROM public.warehouses w
 WHERE NOT EXISTS (
   SELECT 1 FROM public.wms_crossdock_rules r WHERE r.warehouse_id = w.id
 );

-- Rule resolver ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public._wms_crossdock_resolve_rule(p_business_id uuid, p_warehouse_id uuid)
RETURNS public.wms_crossdock_rules
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT * FROM public.wms_crossdock_rules
   WHERE business_id = p_business_id
     AND is_active
     AND (warehouse_id = p_warehouse_id OR warehouse_id IS NULL)
   ORDER BY (warehouse_id IS NOT NULL) DESC, priority ASC, created_at ASC
   LIMIT 1;
$$;

-- Core detection engine -------------------------------------------------
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

  -- ---- line-level disqualifiers (recorded, not silent) ----------------
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

  -- ---- candidate demand: sales orders + outbound transfers ------------
  FOR v_cand IN
    WITH demand AS (
      SELECT 'sales_order'::public.wms_crossdock_demand_type AS demand_type,
             so.id AS doc_id, soi.id AS line_id, so.branch_id AS branch_id,
             (COALESCE(soi.quantity,0) - COALESCE(soi.quantity_fulfilled,0)) AS open_qty,
             COALESCE(so.expected_date::timestamptz, so.order_date::timestamptz + interval '48 hours') AS cutoff,
             so.order_date::timestamptz AS ordered_at
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
             st.transfer_date::timestamptz
        FROM public.stock_transfer_items sti
        JOIN public.stock_transfers st ON st.id = sti.transfer_id
       WHERE st.business_id = p_business_id
         AND st.from_warehouse_id = p_warehouse_id
         AND sti.product_id = p_product_id
         AND st.status IN ('pending','approved','in_transit_pending','draft')
         AND (COALESCE(sti.quantity_requested,0) - COALESCE(sti.quantity_sent,0)) > 0
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

    -- score: urgency (0-50) + fill completeness (0-30) + full-line bonus (20)
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
      reject_reason, approved_at
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
      CASE WHEN v_state = 'approved' THEN now() END
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

-- Rewire the two entry points ------------------------------------------
CREATE OR REPLACE FUNCTION public.evaluate_crossdock_on_receiving_line(p_line_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_line public.wms_receiving_lines;
  v_wh   public.warehouses;
BEGIN
  SELECT * INTO v_line FROM public.wms_receiving_lines WHERE id = p_line_id;
  IF NOT FOUND THEN RETURN 0; END IF;
  IF COALESCE(v_line.received_qty,0) <= 0 OR v_line.product_id IS NULL THEN RETURN 0; END IF;

  SELECT * INTO v_wh FROM public.warehouses WHERE id = v_line.warehouse_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  RETURN public._wms_crossdock_detect(
    v_wh.business_id, v_line.warehouse_id, v_line.product_id,
    COALESCE(v_line.received_qty,0) - COALESCE(v_line.damaged_qty,0),
    NULL, NULL, p_line_id,
    v_line.lot_number, v_line.expiry_date, COALESCE(v_line.qc_hold, false)
  );
END $$;

CREATE OR REPLACE FUNCTION public.evaluate_crossdock_on_grn(p_grn_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_grn   public.goods_receipts;
  v_wh    public.warehouses;
  v_line  record;
  v_hold  boolean;
  v_exp   date;
  v_count int := 0;
BEGIN
  SELECT * INTO v_grn FROM public.goods_receipts WHERE id = p_grn_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'goods receipt not found'; END IF;
  IF v_grn.status <> 'completed' OR v_grn.warehouse_id IS NULL THEN RETURN 0; END IF;

  SELECT * INTO v_wh FROM public.warehouses WHERE id = v_grn.warehouse_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  FOR v_line IN
    SELECT gri.* FROM public.goods_receipt_items gri
     WHERE gri.goods_receipt_id = p_grn_id
       AND gri.quantity_received > 0
       AND gri.product_id IS NOT NULL
  LOOP
    v_hold := EXISTS (
      SELECT 1 FROM public.wms_qc_inspections q
       WHERE q.id = v_line.qc_inspection_id AND q.state = 'open'
    );
    SELECT sl.expiry_date INTO v_exp
      FROM public.stock_lots sl
     WHERE sl.business_id = v_wh.business_id
       AND sl.product_id = v_line.product_id
       AND sl.lot_number = v_line.lot_number
     LIMIT 1;

    v_count := v_count + public._wms_crossdock_detect(
      v_wh.business_id, v_grn.warehouse_id, v_line.product_id, v_line.quantity_received,
      p_grn_id, v_line.id, NULL, v_line.lot_number, v_exp, v_hold
    );
  END LOOP;

  RETURN v_count;
END $$;
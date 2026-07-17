-- Phase 8 — Replenishment rules + slotting velocity

-- ---------------------------------------------------------------------------
-- 1) wms_replenishment_rules
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_replenishment_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  warehouse_id uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  pick_location_id uuid NOT NULL REFERENCES public.stock_locations(id) ON DELETE CASCADE,
  source_location_id uuid REFERENCES public.stock_locations(id) ON DELETE SET NULL,
  min_qty numeric NOT NULL CHECK (min_qty >= 0),
  max_qty numeric NOT NULL CHECK (max_qty > 0),
  pack_multiple numeric NOT NULL DEFAULT 1 CHECK (pack_multiple > 0),
  priority integer NOT NULL DEFAULT 5,
  is_active boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wms_replen_min_le_max CHECK (min_qty <= max_qty),
  CONSTRAINT wms_replen_unique_pickloc UNIQUE (warehouse_id, product_id, pick_location_id)
);

CREATE INDEX IF NOT EXISTS idx_wms_replen_wh_active ON public.wms_replenishment_rules(warehouse_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_wms_replen_biz ON public.wms_replenishment_rules(business_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_replenishment_rules TO authenticated;
GRANT ALL ON public.wms_replenishment_rules TO service_role;

ALTER TABLE public.wms_replenishment_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wms_replen_biz_read" ON public.wms_replenishment_rules
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()));

CREATE POLICY "wms_replen_biz_write" ON public.wms_replenishment_rules
  FOR ALL TO authenticated
  USING (business_id IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()))
  WITH CHECK (business_id IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()));

CREATE TRIGGER trg_wms_replen_updated_at
  BEFORE UPDATE ON public.wms_replenishment_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- 2) generate_replenishment_tasks(warehouse) RPC
--    Scans active rules; creates a `replenish` wms_task for each pick face
--    that dropped below min. Skips rules with an already-open task.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_replenishment_tasks(p_warehouse_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_wh public.warehouses;
  v_rule record;
  v_onhand numeric;
  v_source_onhand numeric;
  v_needed numeric;
  v_source uuid;
  v_existing uuid;
  v_created int := 0;
  v_skipped int := 0;
  v_task_id uuid;
BEGIN
  SELECT * INTO v_wh FROM public.warehouses WHERE id = p_warehouse_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'warehouse not found'; END IF;
  IF v_wh.business_id NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  FOR v_rule IN
    SELECT r.*
      FROM public.wms_replenishment_rules r
     WHERE r.warehouse_id = p_warehouse_id
       AND r.is_active = true
     ORDER BY r.priority ASC, r.created_at ASC
  LOOP
    -- On-hand at the pick face (net of reservations).
    SELECT COALESCE(SUM(quantity - COALESCE(reserved_quantity,0)), 0)
      INTO v_onhand
      FROM public.stock_quants
     WHERE location_id = v_rule.pick_location_id
       AND product_id = v_rule.product_id;

    IF v_onhand >= v_rule.min_qty THEN
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;

    -- Skip if an open replenish task already exists for this pick face.
    SELECT id INTO v_existing
      FROM public.wms_tasks
     WHERE warehouse_id = p_warehouse_id
       AND task_type = 'replenish'
       AND destination_location_id = v_rule.pick_location_id
       AND product_id = v_rule.product_id
       AND state IN ('pending','assigned','in_progress')
     LIMIT 1;
    IF v_existing IS NOT NULL THEN
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;

    -- Resolve source: rule-supplied, else default putaway/storage.
    v_source := v_rule.source_location_id;
    IF v_source IS NULL THEN
      v_source := public._wms_default_putaway(p_warehouse_id);
    END IF;

    -- Verify source has stock.
    SELECT COALESCE(SUM(quantity - COALESCE(reserved_quantity,0)), 0)
      INTO v_source_onhand
      FROM public.stock_quants
     WHERE location_id = v_source AND product_id = v_rule.product_id;
    IF v_source_onhand <= 0 THEN
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;

    -- Refill up to max, rounded up to pack_multiple, clamped by source.
    v_needed := v_rule.max_qty - v_onhand;
    IF v_rule.pack_multiple > 1 THEN
      v_needed := ceil(v_needed / v_rule.pack_multiple) * v_rule.pack_multiple;
    END IF;
    v_needed := LEAST(v_needed, v_source_onhand);
    IF v_needed <= 0 THEN
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;

    INSERT INTO public.wms_tasks (
      organization_id, business_id, branch_id, warehouse_id,
      task_type, state, priority,
      source_location_id, destination_location_id,
      product_id, quantity,
      source_doc_type, source_doc_id,
      notes, created_by, metadata
    ) VALUES (
      v_wh.organization_id, v_wh.business_id, v_wh.branch_id, p_warehouse_id,
      'replenish', 'pending', v_rule.priority,
      v_source, v_rule.pick_location_id,
      v_rule.product_id, v_needed,
      'wms_replenishment_rule', v_rule.id,
      'Auto replenishment (min=' || v_rule.min_qty || ', max=' || v_rule.max_qty || ')',
      auth.uid(),
      jsonb_build_object('rule_id', v_rule.id, 'on_hand_before', v_onhand)
    ) RETURNING id INTO v_task_id;

    UPDATE public.wms_replenishment_rules
       SET last_run_at = now()
     WHERE id = v_rule.id;

    v_created := v_created + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'warehouse_id', p_warehouse_id,
    'tasks_created', v_created,
    'rules_skipped', v_skipped
  );
END; $$;

REVOKE ALL ON FUNCTION public.generate_replenishment_tasks(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_replenishment_tasks(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3) wms_slotting_velocity_view — A/B/C classification over last 90 days
--    based on completed pick tasks per product per warehouse.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.wms_slotting_velocity_view AS
WITH picks AS (
  SELECT
    t.warehouse_id,
    t.business_id,
    t.product_id,
    COUNT(*)         AS pick_count,
    SUM(t.quantity)  AS pick_qty
  FROM public.wms_tasks t
  WHERE t.task_type = 'pick'
    AND t.state = 'done'
    AND t.completed_at >= now() - interval '90 days'
    AND t.product_id IS NOT NULL
  GROUP BY t.warehouse_id, t.business_id, t.product_id
),
ranked AS (
  SELECT
    p.*,
    PERCENT_RANK() OVER (PARTITION BY p.warehouse_id ORDER BY p.pick_count) AS pct_by_count
  FROM picks p
)
SELECT
  r.warehouse_id,
  r.business_id,
  r.product_id,
  r.pick_count,
  r.pick_qty,
  r.pct_by_count,
  CASE
    WHEN r.pct_by_count >= 0.80 THEN 'A'
    WHEN r.pct_by_count >= 0.50 THEN 'B'
    ELSE 'C'
  END AS velocity_class
FROM ranked r;

GRANT SELECT ON public.wms_slotting_velocity_view TO authenticated, service_role;

COMMENT ON VIEW public.wms_slotting_velocity_view IS
  'Rolling 90-day pick velocity per product per warehouse, with A/B/C bucket for slotting decisions.';
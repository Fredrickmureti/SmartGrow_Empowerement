-- =====================================================================
-- ADR 0106 — Replenishment execution subsystem
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Drop the unused duplicate rule table (verified 0 rows)
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS public.wms_replen_rules;

-- ---------------------------------------------------------------------
-- 1. Hierarchical rule model
-- ---------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.wms_replen_scope AS ENUM ('warehouse','zone','category','product','pick_face');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.wms_replen_strategy AS ENUM ('min_max','demand_driven','topoff','manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.wms_replen_order_state AS ENUM
    ('planned','approved','dispatched','in_progress','completed','short','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.wms_replenishment_rules
  ADD COLUMN IF NOT EXISTS scope public.wms_replen_scope NOT NULL DEFAULT 'pick_face',
  ADD COLUMN IF NOT EXISTS strategy public.wms_replen_strategy NOT NULL DEFAULT 'min_max',
  ADD COLUMN IF NOT EXISTS zone_location_id uuid REFERENCES public.stock_locations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS category_id uuid,
  ADD COLUMN IF NOT EXISTS velocity_class text,
  ADD COLUMN IF NOT EXISTS target_qty numeric,
  ADD COLUMN IF NOT EXISTS effective_from timestamptz,
  ADD COLUMN IF NOT EXISTS effective_to timestamptz,
  ADD COLUMN IF NOT EXISTS is_emergency boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_dispatch boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1;

ALTER TABLE public.wms_replenishment_rules
  ALTER COLUMN product_id DROP NOT NULL,
  ALTER COLUMN pick_location_id DROP NOT NULL;

ALTER TABLE public.wms_replenishment_rules
  DROP CONSTRAINT IF EXISTS wms_replen_unique_pickloc;

CREATE UNIQUE INDEX IF NOT EXISTS uq_wms_replen_pick_face
  ON public.wms_replenishment_rules(warehouse_id, product_id, pick_location_id)
  WHERE scope = 'pick_face';

ALTER TABLE public.wms_replenishment_rules
  DROP CONSTRAINT IF EXISTS wms_replen_scope_keys;
ALTER TABLE public.wms_replenishment_rules
  ADD CONSTRAINT wms_replen_scope_keys CHECK (
    CASE scope
      WHEN 'pick_face' THEN pick_location_id IS NOT NULL AND product_id IS NOT NULL
      WHEN 'product'   THEN product_id IS NOT NULL
      WHEN 'category'  THEN category_id IS NOT NULL
      WHEN 'zone'      THEN zone_location_id IS NOT NULL
      ELSE true
    END
  );

CREATE INDEX IF NOT EXISTS idx_wms_replen_scope ON public.wms_replenishment_rules(warehouse_id, scope) WHERE is_active;

-- ---------------------------------------------------------------------
-- 2. Replenishment order aggregate (the plan, distinct from the work)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_replen_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  warehouse_id uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  rule_id uuid REFERENCES public.wms_replenishment_rules(id) ON DELETE SET NULL,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  pick_location_id uuid NOT NULL REFERENCES public.stock_locations(id) ON DELETE CASCADE,
  source_location_id uuid REFERENCES public.stock_locations(id) ON DELETE SET NULL,
  lot_number text,
  state public.wms_replen_order_state NOT NULL DEFAULT 'planned',
  priority integer NOT NULL DEFAULT 5,
  requested_qty numeric NOT NULL CHECK (requested_qty > 0),
  moved_qty numeric NOT NULL DEFAULT 0,
  reserved_qty numeric NOT NULL DEFAULT 0,
  reason_code text NOT NULL DEFAULT 'below_min',
  decision_trace jsonb NOT NULL DEFAULT '{}'::jsonb,
  task_id uuid REFERENCES public.wms_tasks(id) ON DELETE SET NULL,
  due_at timestamptz,
  dispatched_at timestamptz,
  completed_at timestamptz,
  cancel_reason text,
  row_version integer NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_replen_orders TO authenticated;
GRANT ALL ON public.wms_replen_orders TO service_role;

ALTER TABLE public.wms_replen_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wms_replen_orders read" ON public.wms_replen_orders;
CREATE POLICY "wms_replen_orders read" ON public.wms_replen_orders
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

DROP POLICY IF EXISTS "wms_replen_orders write" ON public.wms_replen_orders;
CREATE POLICY "wms_replen_orders write" ON public.wms_replen_orders
  FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id));

CREATE INDEX IF NOT EXISTS idx_wms_replen_orders_open
  ON public.wms_replen_orders(warehouse_id, state, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_wms_replen_orders_pickface
  ON public.wms_replen_orders(pick_location_id, product_id)
  WHERE state IN ('planned','approved','dispatched','in_progress');

DROP TRIGGER IF EXISTS trg_wms_replen_orders_touch ON public.wms_replen_orders;
CREATE TRIGGER trg_wms_replen_orders_touch
  BEFORE UPDATE ON public.wms_replen_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- state-change events via the shared emitter
DROP TRIGGER IF EXISTS trg_wms_replen_orders_emit ON public.wms_replen_orders;
CREATE TRIGGER trg_wms_replen_orders_emit
  AFTER INSERT OR UPDATE OF state ON public.wms_replen_orders
  FOR EACH ROW EXECUTE FUNCTION public._wms_emit_state_change(
    'replen_order', 'warehouse.replen.', 'state',
    'planned,approved,dispatched,in_progress,completed,short,cancelled'
  );

ALTER PUBLICATION supabase_realtime ADD TABLE public.wms_replen_orders;

INSERT INTO public.wms_events_catalog (topic, aggregate, transition, idempotency_key_shape, description)
SELECT v.topic, 'replen_order', v.transition,
       'wms.replen_order:{id}:' || v.transition, v.descr
  FROM (VALUES
    ('warehouse.replen.planned',    'planned',     'Replenishment order planned by the engine'),
    ('warehouse.replen.approved',   'approved',    'Supervisor approved a replenishment order'),
    ('warehouse.replen.dispatched', 'dispatched',  'Replenishment order dispatched as an operator task'),
    ('warehouse.replen.in_progress','in_progress', 'Operator started the replenishment move'),
    ('warehouse.replen.completed',  'completed',   'Replenishment move completed, pick face refilled'),
    ('warehouse.replen.short',      'short',       'Replenishment completed short of the requested quantity'),
    ('warehouse.replen.cancelled',  'cancelled',   'Replenishment order cancelled')
  ) AS v(topic, transition, descr)
 WHERE NOT EXISTS (SELECT 1 FROM public.wms_events_catalog c WHERE c.topic = v.topic);

-- ---------------------------------------------------------------------
-- 3. Reservation helpers (source stock held while an order is in flight)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._wms_replen_reserve(p_order public.wms_replen_orders, p_qty numeric)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_q record; v_left numeric := p_qty; v_take numeric; v_done numeric := 0;
BEGIN
  IF p_order.source_location_id IS NULL OR p_qty <= 0 THEN RETURN 0; END IF;
  FOR v_q IN
    SELECT id, quantity, COALESCE(reserved_quantity,0) AS reserved
      FROM public.stock_quants
     WHERE location_id = p_order.source_location_id
       AND product_id = p_order.product_id
       AND (p_order.lot_number IS NULL OR lot_number IS NOT DISTINCT FROM p_order.lot_number)
     ORDER BY updated_at
     FOR UPDATE
  LOOP
    EXIT WHEN v_left <= 0;
    v_take := LEAST(v_left, GREATEST(v_q.quantity - v_q.reserved, 0));
    IF v_take > 0 THEN
      UPDATE public.stock_quants SET reserved_quantity = COALESCE(reserved_quantity,0) + v_take, updated_at = now()
       WHERE id = v_q.id;
      v_left := v_left - v_take;
      v_done := v_done + v_take;
    END IF;
  END LOOP;
  RETURN v_done;
END; $$;

CREATE OR REPLACE FUNCTION public._wms_replen_release(p_order public.wms_replen_orders, p_qty numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_q record; v_left numeric := p_qty; v_take numeric;
BEGIN
  IF p_order.source_location_id IS NULL OR p_qty <= 0 THEN RETURN; END IF;
  FOR v_q IN
    SELECT id, COALESCE(reserved_quantity,0) AS reserved
      FROM public.stock_quants
     WHERE location_id = p_order.source_location_id
       AND product_id = p_order.product_id
       AND COALESCE(reserved_quantity,0) > 0
     ORDER BY updated_at
     FOR UPDATE
  LOOP
    EXIT WHEN v_left <= 0;
    v_take := LEAST(v_left, v_q.reserved);
    UPDATE public.stock_quants SET reserved_quantity = COALESCE(reserved_quantity,0) - v_take, updated_at = now()
     WHERE id = v_q.id;
    v_left := v_left - v_take;
  END LOOP;
END; $$;

-- ---------------------------------------------------------------------
-- 4. Effective-rule resolution (hierarchy precedence)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_effective_replen_rule(
  p_warehouse_id uuid, p_product_id uuid, p_pick_location_id uuid
) RETURNS public.wms_replenishment_rules
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH loc AS (
    SELECT id, parent_location_id FROM public.stock_locations WHERE id = p_pick_location_id
  ), prod AS (
    SELECT id, category_id FROM public.products WHERE id = p_product_id
  )
  SELECT r.*
    FROM public.wms_replenishment_rules r, loc, prod
   WHERE r.warehouse_id = p_warehouse_id
     AND r.is_active
     AND (r.effective_from IS NULL OR r.effective_from <= now())
     AND (r.effective_to   IS NULL OR r.effective_to   >= now())
     AND (
       (r.scope = 'pick_face' AND r.pick_location_id = loc.id AND r.product_id = prod.id)
       OR (r.scope = 'product'  AND r.product_id = prod.id)
       OR (r.scope = 'category' AND r.category_id IS NOT DISTINCT FROM prod.category_id)
       OR (r.scope = 'zone'     AND r.zone_location_id = loc.parent_location_id)
       OR (r.scope = 'warehouse')
     )
   ORDER BY r.is_emergency DESC,
            CASE r.scope
              WHEN 'pick_face' THEN 1 WHEN 'product' THEN 2
              WHEN 'category'  THEN 3 WHEN 'zone'    THEN 4 ELSE 5 END,
            r.priority ASC, r.created_at ASC
   LIMIT 1;
$$;

-- ---------------------------------------------------------------------
-- 5. Planning engine
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.plan_replenishment(uuid, text);
CREATE OR REPLACE FUNCTION public.plan_replenishment(
  p_warehouse_id uuid,
  p_mode text DEFAULT 'plan_and_dispatch'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_wh public.warehouses;
  v_face record;
  v_rule public.wms_replenishment_rules;
  v_onhand numeric;
  v_allocated numeric;
  v_inflight numeric;
  v_projected numeric;
  v_target numeric;
  v_needed numeric;
  v_src record;
  v_rejected jsonb;
  v_order public.wms_replen_orders;
  v_created int := 0;
  v_dispatched int := 0;
  v_skipped int := 0;
  v_reserved numeric;
  v_task_id uuid;
BEGIN
  SELECT * INTO v_wh FROM public.warehouses WHERE id = p_warehouse_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'warehouse not found'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_wh.business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  -- Candidate pick faces: every (pick location, product) that either has a
  -- pick_face rule or currently carries stock in a pick-usage location.
  FOR v_face IN
    SELECT DISTINCT pick_location_id, product_id FROM (
      SELECT r.pick_location_id, r.product_id
        FROM public.wms_replenishment_rules r
       WHERE r.warehouse_id = p_warehouse_id AND r.is_active AND r.scope = 'pick_face'
       UNION
      SELECT q.location_id, q.product_id
        FROM public.stock_quants q
        JOIN public.stock_locations l ON l.id = q.location_id
       WHERE l.warehouse_id = p_warehouse_id
         AND l.is_active
         AND l.usage = 'storage'
         AND l.pick_sequence IS NOT NULL
    ) s
  LOOP
    v_rule := public.wms_effective_replen_rule(p_warehouse_id, v_face.product_id, v_face.pick_location_id);
    IF v_rule.id IS NULL OR v_rule.strategy = 'manual' THEN
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;

    -- Idempotency: one open order per pick face + product.
    IF EXISTS (
      SELECT 1 FROM public.wms_replen_orders o
       WHERE o.pick_location_id = v_face.pick_location_id
         AND o.product_id = v_face.product_id
         AND o.state IN ('planned','approved','dispatched','in_progress')
    ) THEN
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;

    SELECT COALESCE(SUM(quantity), 0) INTO v_onhand
      FROM public.stock_quants
     WHERE location_id = v_face.pick_location_id AND product_id = v_face.product_id;

    -- Demand allocated to open picking waves for this product.
    SELECT COALESCE(SUM(GREATEST(wl.quantity_ordered - COALESCE(wl.quantity_picked,0), 0)), 0)
      INTO v_allocated
      FROM public.wms_pick_wave_lines wl
      JOIN public.wms_pick_waves w ON w.id = wl.wave_id
     WHERE w.warehouse_id = p_warehouse_id
       AND wl.product_id = v_face.product_id
       AND w.state IN ('released','picking');

    -- Refill already in flight towards this pick face.
    SELECT COALESCE(SUM(o.requested_qty - o.moved_qty), 0) INTO v_inflight
      FROM public.wms_replen_orders o
     WHERE o.pick_location_id = v_face.pick_location_id
       AND o.product_id = v_face.product_id
       AND o.state IN ('approved','dispatched','in_progress');

    v_projected := v_onhand - CASE WHEN v_rule.strategy = 'min_max' THEN 0 ELSE v_allocated END + v_inflight;

    IF v_projected >= v_rule.min_qty AND v_rule.strategy <> 'topoff' THEN
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;

    v_target := COALESCE(v_rule.target_qty, v_rule.max_qty);
    v_needed := v_target - v_projected;
    IF v_rule.pack_multiple > 1 THEN
      v_needed := ceil(v_needed / v_rule.pack_multiple) * v_rule.pack_multiple;
    END IF;
    IF v_needed <= 0 THEN v_skipped := v_skipped + 1; CONTINUE; END IF;

    -- Source selection: reserve/bulk locations in the same warehouse,
    -- FEFO by lot expiry where lots are tracked, most stock first.
    v_rejected := '[]'::jsonb;
    SELECT * INTO v_src FROM (
      SELECT q.location_id,
             q.lot_number,
             SUM(q.quantity - COALESCE(q.reserved_quantity,0)) AS available,
             MIN(sl.expiry_date) AS expiry
        FROM public.stock_quants q
        JOIN public.stock_locations l ON l.id = q.location_id
        LEFT JOIN public.stock_lots sl
               ON sl.product_id = q.product_id
              AND sl.lot_number = q.lot_number
       WHERE l.warehouse_id = p_warehouse_id
         AND l.is_active
         AND l.usage = 'storage'
         AND q.product_id = v_face.product_id
         AND q.location_id <> v_face.pick_location_id
         AND (v_rule.source_location_id IS NULL OR q.location_id = v_rule.source_location_id)
       GROUP BY q.location_id, q.lot_number
      HAVING SUM(q.quantity - COALESCE(q.reserved_quantity,0)) > 0
       ORDER BY expiry NULLS LAST, available DESC
       LIMIT 1
    ) c;

    IF v_src.location_id IS NULL THEN
      v_rejected := jsonb_build_array(jsonb_build_object('reason','no_source_stock'));
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_needed := LEAST(v_needed, v_src.available);
    IF v_needed <= 0 THEN v_skipped := v_skipped + 1; CONTINUE; END IF;

    INSERT INTO public.wms_replen_orders (
      organization_id, business_id, branch_id, warehouse_id,
      rule_id, product_id, pick_location_id, source_location_id, lot_number,
      state, priority, requested_qty, reason_code, decision_trace, created_by
    ) VALUES (
      v_wh.organization_id, v_wh.business_id, v_wh.branch_id, p_warehouse_id,
      v_rule.id, v_face.product_id, v_face.pick_location_id, v_src.location_id, v_src.lot_number,
      'planned', v_rule.priority, v_needed,
      CASE WHEN v_rule.is_emergency THEN 'emergency'
           WHEN v_rule.strategy = 'topoff' THEN 'topoff'
           WHEN v_projected <= 0 THEN 'stockout' ELSE 'below_min' END,
      jsonb_build_object(
        'rule_id', v_rule.id, 'rule_scope', v_rule.scope, 'strategy', v_rule.strategy,
        'on_hand', v_onhand, 'allocated_to_waves', v_allocated, 'inflight', v_inflight,
        'projected', v_projected, 'min_qty', v_rule.min_qty, 'target_qty', v_target,
        'pack_multiple', v_rule.pack_multiple,
        'source_location_id', v_src.location_id, 'source_available', v_src.available,
        'source_lot', v_src.lot_number, 'source_expiry', v_src.expiry,
        'rejected_candidates', v_rejected,
        'planned_at', now()
      ),
      auth.uid()
    ) RETURNING * INTO v_order;

    v_created := v_created + 1;
    UPDATE public.wms_replenishment_rules SET last_run_at = now() WHERE id = v_rule.id;

    IF p_mode = 'plan_and_dispatch' AND v_rule.auto_dispatch THEN
      v_reserved := public._wms_replen_reserve(v_order, v_order.requested_qty);

      INSERT INTO public.wms_tasks (
        organization_id, business_id, branch_id, warehouse_id,
        task_type, state, priority,
        source_location_id, destination_location_id,
        product_id, lot_number, quantity,
        source_doc_type, source_doc_id, notes, created_by, metadata
      ) VALUES (
        v_wh.organization_id, v_wh.business_id, v_wh.branch_id, p_warehouse_id,
        'replenish', 'available', v_rule.priority,
        v_order.source_location_id, v_order.pick_location_id,
        v_order.product_id, v_order.lot_number, v_order.requested_qty,
        'wms_replen_order', v_order.id,
        'Replenishment ' || v_order.reason_code, auth.uid(),
        jsonb_build_object('replen_order_id', v_order.id, 'rule_id', v_rule.id)
      ) RETURNING id INTO v_task_id;

      UPDATE public.wms_replen_orders
         SET state = 'dispatched', task_id = v_task_id, dispatched_at = now(),
             reserved_qty = v_reserved, row_version = row_version + 1
       WHERE id = v_order.id;

      v_dispatched := v_dispatched + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'warehouse_id', p_warehouse_id,
    'mode', p_mode,
    'orders_created', v_created,
    'orders_dispatched', v_dispatched,
    'faces_skipped', v_skipped
  );
END; $$;

REVOKE ALL ON FUNCTION public.plan_replenishment(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.plan_replenishment(uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 6. Order FSM
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_transition_replen_order(
  p_order_id uuid,
  p_to_state public.wms_replen_order_state,
  p_expected_version integer,
  p_reason text DEFAULT NULL
) RETURNS public.wms_replen_orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_o public.wms_replen_orders;
  v_ok boolean;
  v_task_id uuid;
  v_reserved numeric;
BEGIN
  SELECT * INTO v_o FROM public.wms_replen_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'replenishment order not found'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_o.business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF v_o.row_version <> p_expected_version THEN
    RAISE EXCEPTION 'stale order (expected version %, found %)', p_expected_version, v_o.row_version;
  END IF;

  v_ok := CASE v_o.state
    WHEN 'planned'     THEN p_to_state IN ('approved','cancelled')
    WHEN 'approved'    THEN p_to_state IN ('dispatched','cancelled')
    WHEN 'dispatched'  THEN p_to_state IN ('in_progress','completed','short','cancelled')
    WHEN 'in_progress' THEN p_to_state IN ('completed','short','cancelled')
    ELSE false
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'illegal replenishment transition % -> %', v_o.state, p_to_state;
  END IF;

  IF p_to_state = 'dispatched' AND v_o.task_id IS NULL THEN
    v_reserved := public._wms_replen_reserve(v_o, v_o.requested_qty);
    INSERT INTO public.wms_tasks (
      organization_id, business_id, branch_id, warehouse_id,
      task_type, state, priority,
      source_location_id, destination_location_id,
      product_id, lot_number, quantity,
      source_doc_type, source_doc_id, notes, created_by, metadata
    ) VALUES (
      v_o.organization_id, v_o.business_id, v_o.branch_id, v_o.warehouse_id,
      'replenish', 'available', v_o.priority,
      v_o.source_location_id, v_o.pick_location_id,
      v_o.product_id, v_o.lot_number, v_o.requested_qty,
      'wms_replen_order', v_o.id,
      'Replenishment ' || v_o.reason_code, auth.uid(),
      jsonb_build_object('replen_order_id', v_o.id, 'rule_id', v_o.rule_id)
    ) RETURNING id INTO v_task_id;
  END IF;

  IF p_to_state = 'cancelled' THEN
    PERFORM public._wms_replen_release(v_o, v_o.reserved_qty);
    UPDATE public.wms_tasks SET state = 'cancelled', cancel_reason = COALESCE(p_reason,'replenishment cancelled')
     WHERE id = v_o.task_id AND state NOT IN ('done','completed','cancelled');
  END IF;

  UPDATE public.wms_replen_orders
     SET state = p_to_state,
         row_version = row_version + 1,
         task_id = COALESCE(v_task_id, task_id),
         reserved_qty = CASE WHEN p_to_state = 'dispatched' THEN COALESCE(v_reserved, reserved_qty)
                             WHEN p_to_state = 'cancelled' THEN 0 ELSE reserved_qty END,
         dispatched_at = CASE WHEN p_to_state = 'dispatched' THEN now() ELSE dispatched_at END,
         completed_at = CASE WHEN p_to_state IN ('completed','short') THEN now() ELSE completed_at END,
         cancel_reason = CASE WHEN p_to_state = 'cancelled' THEN p_reason ELSE cancel_reason END
   WHERE id = p_order_id
   RETURNING * INTO v_o;

  RETURN v_o;
END; $$;

REVOKE ALL ON FUNCTION public.wms_transition_replen_order(uuid, public.wms_replen_order_state, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_transition_replen_order(uuid, public.wms_replen_order_state, integer, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 7. Execution — the physical move
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_replenish_task(
  p_task_id uuid,
  p_moved_qty numeric,
  p_source_scan text DEFAULT NULL,
  p_destination_scan text DEFAULT NULL,
  p_lot_number text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_task public.wms_tasks;
  v_order public.wms_replen_orders;
  v_src public.stock_locations;
  v_dst public.stock_locations;
  v_available numeric;
  v_short boolean;
  v_movement_id uuid;
BEGIN
  SELECT * INTO v_task FROM public.wms_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'task % not found', p_task_id; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_task.business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF v_task.task_type <> 'replenish' THEN RAISE EXCEPTION 'task is not a replenishment task'; END IF;
  IF v_task.state IN ('done','completed','cancelled') THEN
    RAISE EXCEPTION 'task already closed (%)', v_task.state;
  END IF;
  IF p_moved_qty IS NULL OR p_moved_qty <= 0 THEN RAISE EXCEPTION 'moved qty must be > 0'; END IF;
  IF v_task.source_location_id IS NULL OR v_task.destination_location_id IS NULL THEN
    RAISE EXCEPTION 'task is missing source or destination';
  END IF;

  SELECT * INTO v_src FROM public.stock_locations WHERE id = v_task.source_location_id;
  SELECT * INTO v_dst FROM public.stock_locations WHERE id = v_task.destination_location_id;

  -- Scan validation: accept location code or barcode.
  IF p_source_scan IS NOT NULL
     AND p_source_scan NOT IN (COALESCE(v_src.code,''), COALESCE(v_src.barcode,'')) THEN
    RAISE EXCEPTION 'scanned source % does not match task source %', p_source_scan, v_src.code;
  END IF;
  IF p_destination_scan IS NOT NULL
     AND p_destination_scan NOT IN (COALESCE(v_dst.code,''), COALESCE(v_dst.barcode,'')) THEN
    RAISE EXCEPTION 'scanned destination % does not match pick face %', p_destination_scan, v_dst.code;
  END IF;

  SELECT COALESCE(SUM(quantity), 0) INTO v_available
    FROM public.stock_quants
   WHERE location_id = v_task.source_location_id AND product_id = v_task.product_id;
  IF p_moved_qty > v_available THEN
    RAISE EXCEPTION 'source holds only % units', v_available;
  END IF;

  SELECT * INTO v_order FROM public.wms_replen_orders
   WHERE id = COALESCE((v_task.metadata->>'replen_order_id')::uuid, v_task.source_doc_id)
   FOR UPDATE;

  -- Release the reservation before the movement so the quant maths is clean.
  IF v_order.id IS NOT NULL THEN
    PERFORM public._wms_replen_release(v_order, LEAST(v_order.reserved_qty, p_moved_qty));
  END IF;

  INSERT INTO public.stock_movements (
    organization_id, business_id, branch_id, warehouse_id,
    product_id, movement_type, quantity, lot_number,
    source_location_id, destination_location_id,
    reference_type, reference_id, notes, created_by
  ) VALUES (
    v_task.organization_id, v_task.business_id, v_task.branch_id, v_task.warehouse_id,
    v_task.product_id, 'transfer', p_moved_qty, COALESCE(p_lot_number, v_task.lot_number),
    v_task.source_location_id, v_task.destination_location_id,
    'wms_replen_task', p_task_id,
    'Replenishment ' || COALESCE(v_src.code,'?') || ' -> ' || COALESCE(v_dst.code,'?'),
    auth.uid()
  ) RETURNING id INTO v_movement_id;

  v_short := p_moved_qty < COALESCE(v_task.quantity, p_moved_qty);

  UPDATE public.wms_tasks
     SET state = 'done',
         quantity = p_moved_qty,
         completed_at = now(),
         started_at = COALESCE(started_at, now()),
         assignee_user_id = COALESCE(assignee_user_id, auth.uid()),
         row_version = row_version + 1
   WHERE id = p_task_id;

  IF v_order.id IS NOT NULL THEN
    -- Release any residual reservation when the move came up short.
    IF v_short THEN
      PERFORM public._wms_replen_release(v_order, GREATEST(v_order.reserved_qty - p_moved_qty, 0));
    END IF;
    UPDATE public.wms_replen_orders
       SET state = CASE WHEN v_short THEN 'short' ELSE 'completed' END,
           moved_qty = moved_qty + p_moved_qty,
           reserved_qty = 0,
           completed_at = now(),
           row_version = row_version + 1
     WHERE id = v_order.id;
  END IF;

  IF v_short THEN
    PERFORM public.wms_raise_exception(
      v_task.warehouse_id, 'short_pick'::public.wms_exception_kind,
      'Replenishment short: moved ' || p_moved_qty || ' of ' || v_task.quantity,
      'wms_replen_order', v_order.id, p_task_id, NULL, 2::smallint,
      jsonb_build_object('requested', v_task.quantity, 'moved', p_moved_qty)
    );
  END IF;

  RETURN jsonb_build_object(
    'task_id', p_task_id,
    'order_id', v_order.id,
    'moved_qty', p_moved_qty,
    'short', v_short,
    'movement_id', v_movement_id
  );
END; $$;

REVOKE ALL ON FUNCTION public.complete_replenish_task(uuid, numeric, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_replenish_task(uuid, numeric, text, text, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 8. Retire the legacy generator
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.generate_replenishment_tasks(uuid);
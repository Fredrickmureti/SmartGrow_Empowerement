-- =====================================================================
-- 1. Canonical task-state sweep across every affected function body.
--    The `trg_wms_tasks_canonical_state` guard rejects 'assigned'/'done'
--    on write, but nine live RPCs still emitted them. Every legacy
--    literal in these bodies was verified to sit in a wms_tasks.state
--    context (no non-state literal exists), so a mechanical rewrite is
--    exact: 'assigned' -> 'claimed', 'done' -> 'completed'.
--    Excluded: the guard itself and _wms_emit_task_event, whose legacy
--    literals are a deliberate legacy->canonical mapping table.
-- =====================================================================
DO $sweep$
DECLARE
  r record;
  v_new_def text;
  v_count int := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND pg_get_functiondef(p.oid) ~ 'wms_tasks'
      AND pg_get_functiondef(p.oid) ~ '''(assigned|done)'''
      AND p.proname NOT IN ('_wms_emit_task_event', '_wms_tasks_canonical_state')
  LOOP
    v_new_def := replace(replace(r.def, '''assigned''', '''claimed'''), '''done''', '''completed''');
    EXECUTE v_new_def;
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'canonical task-state sweep rewrote % function(s)', v_count;
END $sweep$;

-- Belt and braces: nothing may still write the retired states.
DO $verify$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ')
    INTO v_bad
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND pg_get_functiondef(p.oid) ~ 'wms_tasks'
    AND pg_get_functiondef(p.oid) ~ '''(assigned|done)'''
    AND p.proname NOT IN ('_wms_emit_task_event', '_wms_tasks_canonical_state');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'retired task states still present in: %', v_bad;
  END IF;
END $verify$;

-- =====================================================================
-- 2. Wave policies: wave-template driven auto-build with an explicit
--    release policy (SAP EWM wave template / Manhattan wave rule model).
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.wms_wave_policies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  business_id         uuid NOT NULL,
  branch_id           uuid,
  warehouse_id        uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  name                text NOT NULL DEFAULT 'Default wave policy',
  is_default          boolean NOT NULL DEFAULT true,
  -- Allocation automatically assigns order lines to a draft wave.
  auto_build          boolean NOT NULL DEFAULT true,
  -- Draft wave releases itself (and so generates pick tasks) on build.
  auto_release        boolean NOT NULL DEFAULT false,
  max_orders_per_wave integer NOT NULL DEFAULT 25,
  task_priority       integer NOT NULL DEFAULT 90,
  notes               text,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_wms_wave_policies_default
  ON public.wms_wave_policies (warehouse_id) WHERE is_default;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_wave_policies TO authenticated;
GRANT ALL ON public.wms_wave_policies TO service_role;

ALTER TABLE public.wms_wave_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wave policies readable within business" ON public.wms_wave_policies;
CREATE POLICY "wave policies readable within business"
  ON public.wms_wave_policies FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

DROP POLICY IF EXISTS "wave policies managed by warehouse managers" ON public.wms_wave_policies;
CREATE POLICY "wave policies managed by warehouse managers"
  ON public.wms_wave_policies FOR ALL TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'warehouse_manager'))
  )
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'warehouse_manager'))
  );

DROP TRIGGER IF EXISTS trg_wms_wave_policies_updated_at ON public.wms_wave_policies;
CREATE TRIGGER trg_wms_wave_policies_updated_at
  BEFORE UPDATE ON public.wms_wave_policies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Default policy for every existing warehouse: build automatically,
-- release under supervisor control.
INSERT INTO public.wms_wave_policies
  (organization_id, business_id, branch_id, warehouse_id, name, is_default, auto_build, auto_release)
SELECT w.organization_id, w.business_id, w.branch_id, w.id,
       'Default wave policy', true, true, false
FROM public.warehouses w
WHERE NOT EXISTS (
  SELECT 1 FROM public.wms_wave_policies p
  WHERE p.warehouse_id = w.id AND p.is_default
);

-- Never wave the same order line twice inside one wave.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wms_pick_wave_lines_item
  ON public.wms_pick_wave_lines (wave_id, sales_order_item_id)
  WHERE sales_order_item_id IS NOT NULL;

-- =====================================================================
-- 3. Allocation -> wave build -> (optional) release
-- =====================================================================
CREATE OR REPLACE FUNCTION public.wms_enqueue_order_for_wave(
  p_sales_order_id uuid,
  p_warehouse_id   uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_so        record;
  v_policy    public.wms_wave_policies;
  v_wave_id   uuid;
  v_wave_no   text;
  v_line      record;
  v_added     int := 0;
  v_orders    int;
  v_released  jsonb := NULL;
BEGIN
  SELECT so.id, so.organization_id, so.business_id, so.branch_id
    INTO v_so
  FROM public.sales_orders so
  WHERE so.id = p_sales_order_id;
  IF v_so.id IS NULL THEN
    RETURN jsonb_build_object('waved', false, 'reason', 'sales_order_not_found');
  END IF;

  SELECT * INTO v_policy
  FROM public.wms_wave_policies
  WHERE business_id = v_so.business_id
    AND (p_warehouse_id IS NULL OR warehouse_id = p_warehouse_id)
    AND auto_build
  ORDER BY is_default DESC, created_at
  LIMIT 1;

  IF v_policy.id IS NULL THEN
    RETURN jsonb_build_object('waved', false, 'reason', 'no_auto_build_policy');
  END IF;

  -- Reuse an open draft wave for this warehouse when it still has room.
  SELECT w.id, w.wave_number INTO v_wave_id, v_wave_no
  FROM public.wms_pick_waves w
  WHERE w.warehouse_id = v_policy.warehouse_id
    AND w.state = 'draft'
  ORDER BY w.created_at DESC
  LIMIT 1;

  IF v_wave_id IS NOT NULL THEN
    SELECT count(DISTINCT sales_order_id) INTO v_orders
    FROM public.wms_pick_wave_lines
    WHERE wave_id = v_wave_id;
    IF v_orders >= v_policy.max_orders_per_wave
       AND NOT EXISTS (
         SELECT 1 FROM public.wms_pick_wave_lines
         WHERE wave_id = v_wave_id AND sales_order_id = p_sales_order_id
       )
    THEN
      v_wave_id := NULL;
    END IF;
  END IF;

  IF v_wave_id IS NULL THEN
    v_wave_no := 'WAVE-' || to_char(now(), 'YYMMDD') || '-'
                 || upper(substr(md5(gen_random_uuid()::text), 1, 5));
    INSERT INTO public.wms_pick_waves (
      organization_id, business_id, branch_id, warehouse_id,
      wave_number, state, strategy, notes, created_by
    ) VALUES (
      v_policy.organization_id, v_policy.business_id, v_policy.branch_id, v_policy.warehouse_id,
      v_wave_no, 'draft', 'batch',
      'Auto-built by wave policy ' || v_policy.name, auth.uid()
    ) RETURNING id INTO v_wave_id;
  END IF;

  FOR v_line IN
    SELECT soi.id AS item_id, soi.sales_order_id, soi.product_id, soi.lot_number,
           GREATEST(COALESCE(soi.quantity,0) - COALESCE(soi.quantity_fulfilled,0), 0) AS qty_open
    FROM public.sales_order_items soi
    WHERE soi.sales_order_id = p_sales_order_id
      AND COALESCE(soi.quantity,0) - COALESCE(soi.quantity_fulfilled,0) > 0
      -- Skip lines already sitting on a live wave.
      AND NOT EXISTS (
        SELECT 1
        FROM public.wms_pick_wave_lines wl
        JOIN public.wms_pick_waves ww ON ww.id = wl.wave_id
        WHERE wl.sales_order_item_id = soi.id
          AND ww.state NOT IN ('cancelled', 'packed')
      )
  LOOP
    INSERT INTO public.wms_pick_wave_lines (
      organization_id, business_id, branch_id,
      wave_id, sales_order_id, sales_order_item_id,
      product_id, lot_number, quantity_ordered
    ) VALUES (
      v_policy.organization_id, v_policy.business_id, v_policy.branch_id,
      v_wave_id, v_line.sales_order_id, v_line.item_id,
      v_line.product_id, v_line.lot_number, v_line.qty_open
    )
    ON CONFLICT DO NOTHING;
    v_added := v_added + 1;
  END LOOP;

  IF v_added > 0 AND v_policy.auto_release THEN
    v_released := public.release_pick_wave(v_wave_id);
  END IF;

  RETURN jsonb_build_object(
    'waved', v_added > 0,
    'wave_id', v_wave_id,
    'wave_number', v_wave_no,
    'lines_added', v_added,
    'auto_released', v_policy.auto_release,
    'release', v_released
  );
END;
$$;

REVOKE ALL ON FUNCTION public.wms_enqueue_order_for_wave(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_enqueue_order_for_wave(uuid, uuid) TO authenticated, service_role;

-- Allocation is the trigger point: a committed sales-order reservation
-- means the demand is real, so it becomes waved pick work.
CREATE OR REPLACE FUNCTION public._wms_wave_on_allocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    PERFORM public.wms_enqueue_order_for_wave(NEW.source_id, NEW.warehouse_id);
  EXCEPTION WHEN OTHERS THEN
    -- Waving must never roll back an allocation.
    RAISE WARNING 'auto-wave failed for sales order %: %', NEW.source_id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_wms_wave_on_allocation ON public.stock_reservations;
CREATE TRIGGER trg_wms_wave_on_allocation
  AFTER INSERT ON public.stock_reservations
  FOR EACH ROW
  WHEN (NEW.source_type = 'sales_order' AND NEW.source_id IS NOT NULL)
  EXECUTE FUNCTION public._wms_wave_on_allocation();

-- =====================================================================
-- 4. QC inspections become first-class operator tasks (EWM QIE model:
--    inspection document drives a warehouse task).
-- =====================================================================
CREATE OR REPLACE FUNCTION public._wms_qc_task_on_open()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hold uuid;
BEGIN
  IF COALESCE(NEW.sample_strategy, 'full') = 'skip' THEN
    RETURN NULL;
  END IF;

  BEGIN
    v_hold := public._wms_ensure_qc_hold(NEW.warehouse_id);
  EXCEPTION WHEN OTHERS THEN
    v_hold := NULL;
  END;

  INSERT INTO public.wms_tasks (
    organization_id, business_id, branch_id, warehouse_id,
    task_type, state, priority,
    source_doc_type, source_doc_id,
    source_location_id,
    product_id, lot_number, quantity,
    assignee_user_id, metadata, payload, created_by
  ) VALUES (
    NEW.organization_id, NEW.business_id, NEW.branch_id, NEW.warehouse_id,
    'qc', CASE WHEN NEW.inspector_id IS NULL THEN 'pending' ELSE 'claimed' END, 80,
    'wms_qc_inspection', NEW.id,
    v_hold,
    NEW.product_id, NEW.lot_number, NEW.quantity,
    NEW.inspector_id,
    jsonb_build_object(
      'inspection_id',   NEW.id,
      'sample_strategy', NEW.sample_strategy,
      'sample_size',     NEW.sample_size,
      'serial_number',   NEW.serial_number,
      'qc_source_doc_type', NEW.source_doc_type,
      'qc_source_doc_id',   NEW.source_doc_id
    ),
    jsonb_build_object('reason', 'qc_inspection_opened'),
    NEW.created_by
  );

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_wms_qc_task_on_open ON public.wms_qc_inspections;
CREATE TRIGGER trg_wms_qc_task_on_open
  AFTER INSERT ON public.wms_qc_inspections
  FOR EACH ROW
  WHEN (NEW.state = 'open')
  EXECUTE FUNCTION public._wms_qc_task_on_open();

CREATE OR REPLACE FUNCTION public._wms_qc_task_on_finalize()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal boolean := NEW.state IN ('accepted','partially_accepted','rejected','cancelled');
BEGIN
  IF NOT v_terminal OR OLD.state = NEW.state THEN
    RETURN NULL;
  END IF;

  UPDATE public.wms_tasks
     SET state        = CASE WHEN NEW.state = 'cancelled' THEN 'cancelled' ELSE 'completed' END,
         completed_at = now(),
         cancel_reason = CASE WHEN NEW.state = 'cancelled'
                              THEN COALESCE(NEW.resolution_notes, 'inspection cancelled')
                              ELSE cancel_reason END,
         row_version  = row_version + 1,
         updated_at   = now(),
         payload      = payload || jsonb_build_object(
                          'reason', 'qc_inspection_' || NEW.state,
                          'accepted_qty', NEW.accepted_qty,
                          'rejected_qty', NEW.rejected_qty,
                          'resolution_kind', NEW.resolution_kind
                        )
   WHERE source_doc_type = 'wms_qc_inspection'
     AND source_doc_id   = NEW.id
     AND state NOT IN ('completed','cancelled');

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_wms_qc_task_on_finalize ON public.wms_qc_inspections;
CREATE TRIGGER trg_wms_qc_task_on_finalize
  AFTER UPDATE OF state ON public.wms_qc_inspections
  FOR EACH ROW EXECUTE FUNCTION public._wms_qc_task_on_finalize();

-- ================================================================
-- Phase 4b — Multi-carton packing
-- ================================================================

-- 1. Cartons table -----------------------------------------------
CREATE TABLE public.wms_pack_cartons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid NULL,
  warehouse_id uuid NULL,
  wave_id uuid NOT NULL REFERENCES public.wms_pick_waves(id) ON DELETE CASCADE,
  sales_order_id uuid NOT NULL,
  shipment_lpn_id uuid NULL REFERENCES public.wms_license_plates(id) ON DELETE SET NULL,
  weight_kg numeric NULL,
  length_cm numeric NULL,
  width_cm numeric NULL,
  height_cm numeric NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  opened_by uuid NULL,
  sealed_at timestamptz NULL,
  sealed_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_wms_pack_cartons_wave_so
  ON public.wms_pack_cartons(wave_id, sales_order_id);
CREATE INDEX idx_wms_pack_cartons_business
  ON public.wms_pack_cartons(business_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_pack_cartons TO authenticated;
GRANT ALL ON public.wms_pack_cartons TO service_role;

ALTER TABLE public.wms_pack_cartons ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wms_pack_cartons business scoped select"
  ON public.wms_pack_cartons FOR SELECT
  TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

CREATE POLICY "wms_pack_cartons business scoped write"
  ON public.wms_pack_cartons FOR ALL
  TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id));

CREATE TRIGGER trg_wms_pack_cartons_updated_at
  BEFORE UPDATE ON public.wms_pack_cartons
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. Wave line link ---------------------------------------------
ALTER TABLE public.wms_pick_wave_lines
  ADD COLUMN IF NOT EXISTS packed_carton_id uuid NULL
    REFERENCES public.wms_pack_cartons(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_wms_pick_wave_lines_carton
  ON public.wms_pick_wave_lines(packed_carton_id);

-- 3. Rewrite complete_pick_task: spawn one pack task per SO ------
CREATE OR REPLACE FUNCTION public.complete_pick_task(
  p_task_id uuid,
  p_picked_qty numeric,
  p_lpn_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_task record;
  v_wave record;
  v_wave_id uuid;
  v_wave_line_id uuid;
  v_wave_open int;
  v_so record;
BEGIN
  SELECT * INTO v_task FROM public.wms_tasks WHERE id = p_task_id;
  IF v_task.id IS NULL THEN RAISE EXCEPTION 'task % not found', p_task_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_task.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF v_task.task_type <> 'pick' THEN RAISE EXCEPTION 'task is not a pick task'; END IF;
  IF v_task.state NOT IN ('pending','assigned','in_progress') THEN
    RAISE EXCEPTION 'task in state % cannot be completed', v_task.state;
  END IF;
  IF p_picked_qty < 0 THEN RAISE EXCEPTION 'picked qty must be >= 0'; END IF;

  v_wave_id      := (v_task.metadata->>'wave_id')::uuid;
  v_wave_line_id := (v_task.metadata->>'wave_line_id')::uuid;

  UPDATE public.wms_tasks
     SET state = 'done',
         quantity = p_picked_qty,
         lpn_id = COALESCE(p_lpn_id, v_task.lpn_id),
         completed_at = now(),
         started_at = COALESCE(started_at, now()),
         assignee_user_id = COALESCE(assignee_user_id, auth.uid())
   WHERE id = p_task_id;

  IF v_wave_line_id IS NOT NULL THEN
    UPDATE public.wms_pick_wave_lines
       SET quantity_picked = quantity_picked + p_picked_qty
     WHERE id = v_wave_line_id;
  END IF;

  IF v_wave_id IS NOT NULL THEN
    SELECT count(*) INTO v_wave_open
      FROM public.wms_tasks
     WHERE task_type = 'pick'
       AND (metadata->>'wave_id')::uuid = v_wave_id
       AND state NOT IN ('done','cancelled');

    IF v_wave_open = 0 THEN
      UPDATE public.wms_pick_waves
         SET state = 'picked'
       WHERE id = v_wave_id AND state IN ('released','picking');

      SELECT * INTO v_wave FROM public.wms_pick_waves WHERE id = v_wave_id;

      -- Spawn one pack task per distinct sales order in the wave, only
      -- if none exist yet (idempotent).
      FOR v_so IN
        SELECT DISTINCT sales_order_id
          FROM public.wms_pick_wave_lines
         WHERE wave_id = v_wave_id
           AND sales_order_id IS NOT NULL
      LOOP
        IF NOT EXISTS (
          SELECT 1 FROM public.wms_tasks
           WHERE task_type = 'pack'
             AND (metadata->>'wave_id')::uuid = v_wave_id
             AND (metadata->>'sales_order_id')::uuid = v_so.sales_order_id
        ) THEN
          INSERT INTO public.wms_tasks (
            organization_id, business_id, branch_id, warehouse_id,
            task_type, state, source_doc_type, source_doc_id,
            metadata, created_by
          ) VALUES (
            v_wave.organization_id, v_wave.business_id, v_wave.branch_id, v_wave.warehouse_id,
            'pack', 'pending', 'sales_order', v_so.sales_order_id,
            jsonb_build_object('wave_id', v_wave_id, 'sales_order_id', v_so.sales_order_id),
            auth.uid()
          );
        END IF;
      END LOOP;
    ELSE
      UPDATE public.wms_pick_waves SET state = 'picking'
       WHERE id = v_wave_id AND state = 'released';
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, warehouse_id, event_type,
      source_doc_type, source_doc_id, payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_task.organization_id, v_task.branch_id, v_task.warehouse_id,
      'warehouse.pick.completed',
      'wms_task', p_task_id,
      jsonb_build_object(
        'task_id', p_task_id,
        'business_id', v_task.business_id,
        'wave_id', v_wave_id,
        'picked_qty', p_picked_qty,
        'lpn_id', COALESCE(p_lpn_id, v_task.lpn_id)
      ),
      'wms.pick.completed:' || p_task_id::text,
      'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wms pick outbox emit failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object('task_id', p_task_id, 'wave_id', v_wave_id, 'picked_qty', p_picked_qty);
END; $$;

-- 4. open_pack_carton -------------------------------------------
CREATE OR REPLACE FUNCTION public.open_pack_carton(
  p_wave_id uuid,
  p_sales_order_id uuid,
  p_shipment_lpn_code text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_wave record;
  v_lpn_id uuid;
  v_carton_id uuid;
  v_code text;
BEGIN
  SELECT * INTO v_wave FROM public.wms_pick_waves WHERE id = p_wave_id;
  IF v_wave.id IS NULL THEN RAISE EXCEPTION 'wave % not found', p_wave_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_wave.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF v_wave.state NOT IN ('picked','packing') THEN
    RAISE EXCEPTION 'wave in state % cannot open cartons', v_wave.state;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.wms_pick_wave_lines
     WHERE wave_id = p_wave_id AND sales_order_id = p_sales_order_id
  ) THEN
    RAISE EXCEPTION 'sales order % not part of wave %', p_sales_order_id, p_wave_id;
  END IF;

  v_code := COALESCE(
    NULLIF(trim(p_shipment_lpn_code), ''),
    'SHIP-' || to_char(now(), 'YYMMDDHH24MISS') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)
  );

  INSERT INTO public.wms_license_plates (
    organization_id, business_id, branch_id, warehouse_id,
    code, lpn_type, status, created_by
  ) VALUES (
    v_wave.organization_id, v_wave.business_id, v_wave.branch_id, v_wave.warehouse_id,
    v_code, 'carton', 'open', auth.uid()
  )
  RETURNING id INTO v_lpn_id;

  INSERT INTO public.wms_pack_cartons (
    organization_id, business_id, branch_id, warehouse_id,
    wave_id, sales_order_id, shipment_lpn_id, opened_by
  ) VALUES (
    v_wave.organization_id, v_wave.business_id, v_wave.branch_id, v_wave.warehouse_id,
    p_wave_id, p_sales_order_id, v_lpn_id, auth.uid()
  )
  RETURNING id INTO v_carton_id;

  UPDATE public.wms_pick_waves SET state = 'packing'
   WHERE id = p_wave_id AND state = 'picked';

  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, warehouse_id, event_type,
      source_doc_type, source_doc_id, payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_wave.organization_id, v_wave.branch_id, v_wave.warehouse_id,
      'warehouse.carton.opened',
      'wms_pack_carton', v_carton_id,
      jsonb_build_object(
        'carton_id', v_carton_id,
        'business_id', v_wave.business_id,
        'wave_id', p_wave_id,
        'sales_order_id', p_sales_order_id,
        'shipment_lpn_id', v_lpn_id,
        'shipment_lpn_code', v_code
      ),
      'wms.carton.opened:' || v_carton_id::text,
      'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wms carton opened outbox emit failed: %', SQLERRM;
  END;

  RETURN v_carton_id;
END; $$;

-- 5. assign_line_to_carton --------------------------------------
CREATE OR REPLACE FUNCTION public.assign_line_to_carton(
  p_carton_id uuid,
  p_wave_line_id uuid,
  p_qty numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_carton record;
  v_line record;
  v_remaining numeric;
BEGIN
  SELECT * INTO v_carton FROM public.wms_pack_cartons WHERE id = p_carton_id;
  IF v_carton.id IS NULL THEN RAISE EXCEPTION 'carton % not found', p_carton_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_carton.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF v_carton.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'carton already sealed'; END IF;

  SELECT * INTO v_line FROM public.wms_pick_wave_lines WHERE id = p_wave_line_id;
  IF v_line.id IS NULL THEN RAISE EXCEPTION 'wave line % not found', p_wave_line_id; END IF;
  IF v_line.wave_id <> v_carton.wave_id THEN RAISE EXCEPTION 'line/carton wave mismatch'; END IF;
  IF v_line.sales_order_id IS DISTINCT FROM v_carton.sales_order_id THEN
    RAISE EXCEPTION 'line/carton sales order mismatch';
  END IF;
  IF v_line.packed_carton_id IS NOT NULL AND v_line.packed_carton_id <> p_carton_id THEN
    RAISE EXCEPTION 'line already packed into another carton';
  END IF;
  IF p_qty <= 0 THEN RAISE EXCEPTION 'quantity must be > 0'; END IF;

  v_remaining := COALESCE(v_line.quantity_picked, 0) - COALESCE(v_line.quantity_packed, 0);
  IF p_qty > v_remaining THEN
    RAISE EXCEPTION 'quantity % exceeds remaining picked (%)', p_qty, v_remaining;
  END IF;

  UPDATE public.wms_pick_wave_lines
     SET quantity_packed = COALESCE(quantity_packed, 0) + p_qty,
         packed_carton_id = p_carton_id
   WHERE id = p_wave_line_id;

  RETURN jsonb_build_object(
    'carton_id', p_carton_id,
    'wave_line_id', p_wave_line_id,
    'quantity_packed', COALESCE(v_line.quantity_packed, 0) + p_qty
  );
END; $$;

-- 6. seal_pack_carton -------------------------------------------
CREATE OR REPLACE FUNCTION public.seal_pack_carton(
  p_carton_id uuid,
  p_weight_kg numeric DEFAULT NULL,
  p_dims jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_carton record;
BEGIN
  SELECT * INTO v_carton FROM public.wms_pack_cartons WHERE id = p_carton_id;
  IF v_carton.id IS NULL THEN RAISE EXCEPTION 'carton % not found', p_carton_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_carton.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF v_carton.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'carton already sealed'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.wms_pick_wave_lines
     WHERE packed_carton_id = p_carton_id
  ) THEN
    RAISE EXCEPTION 'cannot seal an empty carton';
  END IF;

  UPDATE public.wms_pack_cartons
     SET sealed_at = now(),
         sealed_by = auth.uid(),
         weight_kg = COALESCE(p_weight_kg, weight_kg),
         length_cm = COALESCE((p_dims->>'length_cm')::numeric, length_cm),
         width_cm  = COALESCE((p_dims->>'width_cm')::numeric,  width_cm),
         height_cm = COALESCE((p_dims->>'height_cm')::numeric, height_cm)
   WHERE id = p_carton_id;

  IF v_carton.shipment_lpn_id IS NOT NULL THEN
    UPDATE public.wms_license_plates
       SET status = 'sealed', sealed_at = now()
     WHERE id = v_carton.shipment_lpn_id;
  END IF;

  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, warehouse_id, event_type,
      source_doc_type, source_doc_id, payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_carton.organization_id, v_carton.branch_id, v_carton.warehouse_id,
      'warehouse.carton.sealed',
      'wms_pack_carton', p_carton_id,
      jsonb_build_object(
        'carton_id', p_carton_id,
        'business_id', v_carton.business_id,
        'wave_id', v_carton.wave_id,
        'sales_order_id', v_carton.sales_order_id,
        'shipment_lpn_id', v_carton.shipment_lpn_id,
        'weight_kg', p_weight_kg,
        'dims', p_dims
      ),
      'wms.carton.sealed:' || p_carton_id::text,
      'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wms carton sealed outbox emit failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object('carton_id', p_carton_id, 'sealed_at', now());
END; $$;

-- 7. Rewrite complete_pack_task: per-SO ------------------------
DROP FUNCTION IF EXISTS public.complete_pack_task(uuid, text);

CREATE OR REPLACE FUNCTION public.complete_pack_task(
  p_task_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_task record;
  v_wave record;
  v_wave_id uuid;
  v_sales_order_id uuid;
  v_unpacked int;
  v_unsealed int;
  v_open_pack int;
BEGIN
  SELECT * INTO v_task FROM public.wms_tasks WHERE id = p_task_id;
  IF v_task.id IS NULL THEN RAISE EXCEPTION 'task % not found', p_task_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_task.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF v_task.task_type <> 'pack' THEN RAISE EXCEPTION 'task is not a pack task'; END IF;
  IF v_task.state NOT IN ('pending','assigned','in_progress') THEN
    RAISE EXCEPTION 'task in state % cannot be completed', v_task.state;
  END IF;

  v_wave_id        := (v_task.metadata->>'wave_id')::uuid;
  v_sales_order_id := (v_task.metadata->>'sales_order_id')::uuid;
  IF v_wave_id IS NULL OR v_sales_order_id IS NULL THEN
    RAISE EXCEPTION 'pack task missing wave_id / sales_order_id in metadata';
  END IF;

  -- Every wave line for this SO must have a carton assigned.
  SELECT count(*) INTO v_unpacked
    FROM public.wms_pick_wave_lines
   WHERE wave_id = v_wave_id
     AND sales_order_id = v_sales_order_id
     AND COALESCE(quantity_picked, 0) > 0
     AND packed_carton_id IS NULL;
  IF v_unpacked > 0 THEN
    RAISE EXCEPTION '% picked line(s) for this sales order are not yet in a carton', v_unpacked;
  END IF;

  -- Every carton for this SO must be sealed.
  SELECT count(*) INTO v_unsealed
    FROM public.wms_pack_cartons
   WHERE wave_id = v_wave_id
     AND sales_order_id = v_sales_order_id
     AND sealed_at IS NULL;
  IF v_unsealed > 0 THEN
    RAISE EXCEPTION '% open carton(s) must be sealed before completing pack', v_unsealed;
  END IF;

  UPDATE public.wms_tasks
     SET state = 'done',
         completed_at = now(),
         started_at = COALESCE(started_at, now()),
         assignee_user_id = COALESCE(assignee_user_id, auth.uid())
   WHERE id = p_task_id;

  -- Wave rollup: all pack tasks done ⇒ wave packed.
  SELECT count(*) INTO v_open_pack
    FROM public.wms_tasks
   WHERE task_type = 'pack'
     AND (metadata->>'wave_id')::uuid = v_wave_id
     AND state NOT IN ('done','cancelled');

  IF v_open_pack = 0 THEN
    UPDATE public.wms_pick_waves
       SET state = 'packed', completed_at = now()
     WHERE id = v_wave_id AND state IN ('picked','packing');
  END IF;

  SELECT * INTO v_wave FROM public.wms_pick_waves WHERE id = v_wave_id;

  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, warehouse_id, event_type,
      source_doc_type, source_doc_id, payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_task.organization_id, v_task.branch_id, v_task.warehouse_id,
      'warehouse.pack.completed',
      'wms_task', p_task_id,
      jsonb_build_object(
        'task_id', p_task_id,
        'business_id', v_task.business_id,
        'wave_id', v_wave_id,
        'sales_order_id', v_sales_order_id
      ),
      'wms.pack.completed:' || p_task_id::text,
      'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wms pack outbox emit failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'task_id', p_task_id,
    'wave_id', v_wave_id,
    'sales_order_id', v_sales_order_id,
    'wave_state', v_wave.state
  );
END; $$;

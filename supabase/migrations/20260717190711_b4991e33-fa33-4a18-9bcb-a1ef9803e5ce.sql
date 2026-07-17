
-- =====================================================================
-- WMS Phase 3 — Picking, Packing, Waves (ADR 0079)
-- Additive; also patches Phase 2 outbox emitters (org_id, not
-- organization_id — business_event_outbox has no business_id column).
-- =====================================================================

-- ---------- Enums ----------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.wms_wave_state AS ENUM
    ('draft','released','picking','picked','packing','packed','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- Table: wms_pick_waves -----------------------------------
CREATE TABLE IF NOT EXISTS public.wms_pick_waves (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL,
  business_id        uuid NOT NULL,
  branch_id          uuid,
  warehouse_id       uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE RESTRICT,
  wave_number        text NOT NULL,
  state              public.wms_wave_state NOT NULL DEFAULT 'draft',
  strategy           text NOT NULL DEFAULT 'single_order',
  notes              text,
  released_at        timestamptz,
  completed_at       timestamptz,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, wave_number)
);

CREATE INDEX IF NOT EXISTS wms_pick_waves_wh_state_idx
  ON public.wms_pick_waves (warehouse_id, state);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_pick_waves TO authenticated;
GRANT ALL ON public.wms_pick_waves TO service_role;
ALTER TABLE public.wms_pick_waves ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wms_pick_waves_select" ON public.wms_pick_waves FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id)));
CREATE POLICY "wms_pick_waves_write" ON public.wms_pick_waves FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
         AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id)));

CREATE OR REPLACE FUNCTION public._touch_wms_pick_waves_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS tg_touch_wms_pick_waves ON public.wms_pick_waves;
CREATE TRIGGER tg_touch_wms_pick_waves BEFORE UPDATE ON public.wms_pick_waves
  FOR EACH ROW EXECUTE FUNCTION public._touch_wms_pick_waves_updated_at();

-- ---------- Table: wms_pick_wave_lines ------------------------------
CREATE TABLE IF NOT EXISTS public.wms_pick_wave_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL,
  business_id           uuid NOT NULL,
  branch_id             uuid,
  wave_id               uuid NOT NULL REFERENCES public.wms_pick_waves(id) ON DELETE CASCADE,
  sales_order_id        uuid REFERENCES public.sales_orders(id) ON DELETE SET NULL,
  sales_order_item_id   uuid REFERENCES public.sales_order_items(id) ON DELETE SET NULL,
  product_id            uuid NOT NULL,
  lot_number            text,
  quantity_ordered      numeric NOT NULL,
  quantity_picked       numeric NOT NULL DEFAULT 0,
  quantity_packed       numeric NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wms_pick_wave_lines_wave_idx
  ON public.wms_pick_wave_lines (wave_id);
CREATE INDEX IF NOT EXISTS wms_pick_wave_lines_so_idx
  ON public.wms_pick_wave_lines (sales_order_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_pick_wave_lines TO authenticated;
GRANT ALL ON public.wms_pick_wave_lines TO service_role;
ALTER TABLE public.wms_pick_wave_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wms_pick_wave_lines_select" ON public.wms_pick_wave_lines FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id)));
CREATE POLICY "wms_pick_wave_lines_write" ON public.wms_pick_wave_lines FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
         AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id)));

-- =====================================================================
-- Phase 2 outbox fixes — recreate with correct column names.
-- business_event_outbox has: org_id, branch_id, warehouse_id (no business_id / organization_id).
-- =====================================================================
CREATE OR REPLACE FUNCTION public.receive_goods_to_wms(
  p_goods_receipt_id uuid,
  p_staging_location_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
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
      SELECT * FROM public.suggest_putaway_locations(v_gr.warehouse_id, v_line.product_id, v_line.quantity_received)
      LIMIT 3
    LOOP
      v_sug_rank := v_sug_rank + 1;
      INSERT INTO public.wms_putaway_suggestions (
        organization_id, business_id, branch_id,
        task_id, location_id, rank, reason, chosen
      ) VALUES (
        v_gr.organization_id, v_gr.business_id, v_gr.branch_id,
        v_task_id, v_suggestion.location_id, v_sug_rank, v_suggestion.reason,
        v_sug_rank = 1
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
$$;

REVOKE ALL ON FUNCTION public.receive_goods_to_wms(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.receive_goods_to_wms(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.complete_putaway_task(p_task_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_task record;
BEGIN
  SELECT * INTO v_task FROM public.wms_tasks WHERE id = p_task_id;
  IF v_task.id IS NULL THEN RAISE EXCEPTION 'task % not found', p_task_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_task.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF v_task.task_type <> 'putaway' THEN RAISE EXCEPTION 'task is not putaway'; END IF;
  IF v_task.state NOT IN ('assigned','in_progress','pending') THEN
    RAISE EXCEPTION 'task in state % cannot be completed', v_task.state;
  END IF;
  IF v_task.destination_location_id IS NULL THEN RAISE EXCEPTION 'task has no destination'; END IF;
  IF v_task.lpn_id IS NULL THEN RAISE EXCEPTION 'task has no LPN'; END IF;

  PERFORM public.move_lpn(v_task.lpn_id, v_task.destination_location_id, 'putaway task ' || p_task_id::text);

  UPDATE public.wms_tasks
     SET state = 'done', completed_at = now(),
         started_at = COALESCE(started_at, now()),
         assignee_user_id = COALESCE(assignee_user_id, auth.uid())
   WHERE id = p_task_id;

  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, warehouse_id, event_type,
      source_doc_type, source_doc_id, payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_task.organization_id, v_task.branch_id, v_task.warehouse_id,
      'warehouse.putaway.completed',
      'wms_task', p_task_id,
      jsonb_build_object(
        'task_id', p_task_id,
        'business_id', v_task.business_id,
        'lpn_id', v_task.lpn_id,
        'destination_location_id', v_task.destination_location_id
      ),
      'wms.putaway.completed:' || p_task_id::text,
      'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wms putaway outbox emit failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object('task_id', p_task_id, 'state', 'done');
END; $$;

REVOKE ALL ON FUNCTION public.complete_putaway_task(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_putaway_task(uuid) TO authenticated, service_role;

-- =====================================================================
-- RPC: create_pick_wave — draft a wave from sales orders in a warehouse
-- =====================================================================
CREATE OR REPLACE FUNCTION public.create_pick_wave(
  p_warehouse_id uuid,
  p_sales_order_ids uuid[],
  p_notes text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_wh record;
  v_wave_id uuid;
  v_wave_number text;
  v_line record;
  v_lines_created int := 0;
BEGIN
  SELECT id, organization_id, business_id, branch_id INTO v_wh
  FROM public.warehouses WHERE id = p_warehouse_id;
  IF v_wh.id IS NULL THEN RAISE EXCEPTION 'warehouse % not found', p_warehouse_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_wh.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;

  v_wave_number := 'WAVE-' || to_char(now(), 'YYMMDD') || '-' || upper(substr(md5(gen_random_uuid()::text), 1, 5));

  INSERT INTO public.wms_pick_waves (
    organization_id, business_id, branch_id, warehouse_id,
    wave_number, state, strategy, notes, created_by
  ) VALUES (
    v_wh.organization_id, v_wh.business_id, v_wh.branch_id, p_warehouse_id,
    v_wave_number, 'draft',
    CASE WHEN array_length(p_sales_order_ids,1) > 1 THEN 'batch' ELSE 'single_order' END,
    p_notes, auth.uid()
  ) RETURNING id INTO v_wave_id;

  FOR v_line IN
    SELECT soi.id AS item_id, soi.sales_order_id, soi.product_id,
           soi.lot_number,
           GREATEST(COALESCE(soi.quantity,0) - COALESCE(soi.quantity_fulfilled,0), 0) AS qty_open
    FROM public.sales_order_items soi
    JOIN public.sales_orders so ON so.id = soi.sales_order_id
    WHERE soi.sales_order_id = ANY(p_sales_order_ids)
      AND so.business_id = v_wh.business_id
      AND COALESCE(soi.quantity,0) - COALESCE(soi.quantity_fulfilled,0) > 0
  LOOP
    INSERT INTO public.wms_pick_wave_lines (
      organization_id, business_id, branch_id,
      wave_id, sales_order_id, sales_order_item_id,
      product_id, lot_number, quantity_ordered
    ) VALUES (
      v_wh.organization_id, v_wh.business_id, v_wh.branch_id,
      v_wave_id, v_line.sales_order_id, v_line.item_id,
      v_line.product_id, v_line.lot_number, v_line.qty_open
    );
    v_lines_created := v_lines_created + 1;
  END LOOP;

  RETURN jsonb_build_object('wave_id', v_wave_id, 'wave_number', v_wave_number, 'lines_created', v_lines_created);
END; $$;

REVOKE ALL ON FUNCTION public.create_pick_wave(uuid, uuid[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_pick_wave(uuid, uuid[], text) TO authenticated, service_role;

-- =====================================================================
-- RPC: release_pick_wave — reserve stock + generate pick tasks per bin
-- =====================================================================
CREATE OR REPLACE FUNCTION public.release_pick_wave(p_wave_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_wave record;
  v_line record;
  v_remaining numeric;
  v_bin record;
  v_take numeric;
  v_task_id uuid;
  v_tasks int := 0;
  v_task_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  SELECT * INTO v_wave FROM public.wms_pick_waves WHERE id = p_wave_id;
  IF v_wave.id IS NULL THEN RAISE EXCEPTION 'wave % not found', p_wave_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_wave.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF v_wave.state <> 'draft' THEN RAISE EXCEPTION 'wave in state % cannot be released', v_wave.state; END IF;

  FOR v_line IN
    SELECT * FROM public.wms_pick_wave_lines WHERE wave_id = p_wave_id
  LOOP
    v_remaining := v_line.quantity_ordered;

    -- Warehouse-level reservation (matches stock_reservations shape).
    IF v_remaining > 0 THEN
      INSERT INTO public.stock_reservations (
        organization_id, business_id, branch_id, warehouse_id,
        product_id, quantity, source_type, source_id, reserved_by
      ) VALUES (
        v_wave.organization_id, v_wave.business_id, v_wave.branch_id, v_wave.warehouse_id,
        v_line.product_id, v_remaining,
        'pick_wave', p_wave_id, auth.uid()
      );
    END IF;

    -- Generate one pick task per source bin (pick_sequence order).
    FOR v_bin IN
      SELECT sq.location_id, sq.lot_number,
             GREATEST(sq.quantity - COALESCE(sq.reserved_quantity,0), 0) AS available,
             sl.pick_sequence
      FROM public.stock_quants sq
      JOIN public.stock_locations sl ON sl.id = sq.location_id
      WHERE sq.product_id = v_line.product_id
        AND sl.warehouse_id = v_wave.warehouse_id
        AND sl.is_active = true
        AND COALESCE(sl.is_receiving_staging, false) = false
        AND (v_line.lot_number IS NULL OR sq.lot_number = v_line.lot_number)
        AND (sq.quantity - COALESCE(sq.reserved_quantity,0)) > 0
      ORDER BY sl.pick_sequence NULLS LAST, sq.updated_at
    LOOP
      EXIT WHEN v_remaining <= 0;
      v_take := LEAST(v_bin.available, v_remaining);
      IF v_take <= 0 THEN CONTINUE; END IF;

      INSERT INTO public.wms_tasks (
        organization_id, business_id, branch_id, warehouse_id,
        task_type, state, priority,
        source_doc_type, source_doc_id,
        source_location_id,
        product_id, lot_number, quantity,
        metadata, created_by
      ) VALUES (
        v_wave.organization_id, v_wave.business_id, v_wave.branch_id, v_wave.warehouse_id,
        'pick', 'pending', 90,
        'wms_pick_wave', p_wave_id,
        v_bin.location_id,
        v_line.product_id, v_bin.lot_number, v_take,
        jsonb_build_object(
          'wave_id', p_wave_id,
          'wave_line_id', v_line.id,
          'sales_order_id', v_line.sales_order_id,
          'sales_order_item_id', v_line.sales_order_item_id
        ),
        auth.uid()
      ) RETURNING id INTO v_task_id;
      v_tasks := v_tasks + 1;
      v_task_ids := v_task_ids || v_task_id;

      v_remaining := v_remaining - v_take;
    END LOOP;

    IF v_remaining > 0 THEN
      -- Short-pick task without a source bin so operators know to search.
      INSERT INTO public.wms_tasks (
        organization_id, business_id, branch_id, warehouse_id,
        task_type, state, priority,
        source_doc_type, source_doc_id,
        product_id, lot_number, quantity, notes,
        metadata, created_by
      ) VALUES (
        v_wave.organization_id, v_wave.business_id, v_wave.branch_id, v_wave.warehouse_id,
        'pick', 'pending', 95,
        'wms_pick_wave', p_wave_id,
        v_line.product_id, v_line.lot_number, v_remaining,
        'short-pick: no bin found',
        jsonb_build_object(
          'wave_id', p_wave_id,
          'wave_line_id', v_line.id,
          'sales_order_id', v_line.sales_order_id,
          'sales_order_item_id', v_line.sales_order_item_id,
          'short_pick', true
        ),
        auth.uid()
      ) RETURNING id INTO v_task_id;
      v_tasks := v_tasks + 1;
      v_task_ids := v_task_ids || v_task_id;
    END IF;
  END LOOP;

  UPDATE public.wms_pick_waves
     SET state = 'released', released_at = now()
   WHERE id = p_wave_id;

  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, warehouse_id, event_type,
      source_doc_type, source_doc_id, payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_wave.organization_id, v_wave.branch_id, v_wave.warehouse_id,
      'warehouse.wave.released',
      'wms_pick_wave', p_wave_id,
      jsonb_build_object(
        'wave_id', p_wave_id,
        'business_id', v_wave.business_id,
        'tasks_created', v_tasks,
        'task_ids', to_jsonb(v_task_ids)
      ),
      'wms.wave.released:' || p_wave_id::text,
      'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wms wave outbox emit failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object('wave_id', p_wave_id, 'tasks_created', v_tasks, 'task_ids', to_jsonb(v_task_ids));
END; $$;

REVOKE ALL ON FUNCTION public.release_pick_wave(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_pick_wave(uuid) TO authenticated, service_role;

-- =====================================================================
-- RPC: complete_pick_task — record actual picked qty, roll up wave line
-- =====================================================================
CREATE OR REPLACE FUNCTION public.complete_pick_task(
  p_task_id uuid,
  p_picked_qty numeric,
  p_lpn_id uuid DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_task record;
  v_wave_id uuid;
  v_wave_line_id uuid;
  v_line_total numeric;
  v_line_ordered numeric;
  v_wave_open int;
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

    SELECT quantity_picked, quantity_ordered
      INTO v_line_total, v_line_ordered
      FROM public.wms_pick_wave_lines WHERE id = v_wave_line_id;
  END IF;

  -- Wave rollup: if no more open pick tasks, advance to picked.
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

REVOKE ALL ON FUNCTION public.complete_pick_task(uuid, numeric, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_pick_task(uuid, numeric, uuid) TO authenticated, service_role;

-- =====================================================================
-- RPC: complete_pack_task — mark a pack task done; advance wave to packed
-- =====================================================================
CREATE OR REPLACE FUNCTION public.complete_pack_task(
  p_wave_id uuid,
  p_shipment_lpn_code text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_wave record;
  v_shipment_lpn_id uuid;
BEGIN
  SELECT * INTO v_wave FROM public.wms_pick_waves WHERE id = p_wave_id;
  IF v_wave.id IS NULL THEN RAISE EXCEPTION 'wave % not found', p_wave_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_wave.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF v_wave.state NOT IN ('picked','packing') THEN
    RAISE EXCEPTION 'wave in state % cannot be packed', v_wave.state;
  END IF;

  IF p_shipment_lpn_code IS NOT NULL THEN
    INSERT INTO public.wms_license_plates (
      organization_id, business_id, branch_id, warehouse_id,
      code, lpn_type, status, created_by
    ) VALUES (
      v_wave.organization_id, v_wave.business_id, v_wave.branch_id, v_wave.warehouse_id,
      p_shipment_lpn_code, 'carton', 'sealed', auth.uid()
    )
    RETURNING id INTO v_shipment_lpn_id;

    UPDATE public.wms_license_plates SET sealed_at = now() WHERE id = v_shipment_lpn_id;
  END IF;

  UPDATE public.wms_pick_wave_lines
     SET quantity_packed = quantity_picked
   WHERE wave_id = p_wave_id;

  UPDATE public.wms_pick_waves
     SET state = 'packed', completed_at = now()
   WHERE id = p_wave_id;

  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, warehouse_id, event_type,
      source_doc_type, source_doc_id, payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_wave.organization_id, v_wave.branch_id, v_wave.warehouse_id,
      'warehouse.pack.completed',
      'wms_pick_wave', p_wave_id,
      jsonb_build_object(
        'wave_id', p_wave_id,
        'business_id', v_wave.business_id,
        'shipment_lpn_id', v_shipment_lpn_id,
        'shipment_lpn_code', p_shipment_lpn_code
      ),
      'wms.pack.completed:' || p_wave_id::text,
      'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wms pack outbox emit failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object('wave_id', p_wave_id, 'shipment_lpn_id', v_shipment_lpn_id);
END; $$;

REVOKE ALL ON FUNCTION public.complete_pack_task(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_pack_task(uuid, text) TO authenticated, service_role;

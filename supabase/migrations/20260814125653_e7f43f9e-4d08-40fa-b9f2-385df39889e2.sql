-- Phase 2b — last direct writers routed through the engine

DROP FUNCTION IF EXISTS public.release_stock(uuid, uuid, uuid, numeric);
DROP FUNCTION IF EXISTS public.release_reserved_stock(uuid, uuid, numeric);

-- Replenishment holds are released by source, not by decrementing quants
CREATE OR REPLACE FUNCTION public._wms_replen_release(p_order wms_replen_orders, p_qty numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_left numeric := COALESCE(p_qty, 0); v_res RECORD; v_take numeric;
BEGIN
  IF v_left <= 0 THEN RETURN; END IF;

  FOR v_res IN
    SELECT id, quantity FROM public.stock_reservations
     WHERE organization_id = p_order.organization_id
       AND source_type = 'replenishment'
       AND source_id = p_order.id
       AND product_id = p_order.product_id
       AND status IN ('reserved','allocated')
     ORDER BY created_at
     FOR UPDATE
  LOOP
    EXIT WHEN v_left <= 0;
    v_take := LEAST(v_res.quantity, v_left);
    PERFORM public.consume_stock_reservation(p_order.organization_id, v_res.id, v_take);
    v_left := v_left - v_take;
  END LOOP;
END $function$;

-- Wave release: pick_wave holds come from the engine
CREATE OR REPLACE FUNCTION public.release_pick_wave(p_wave_id uuid, p_force boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_wave      record;
  v_line      record;
  v_remaining numeric;
  v_assigned  numeric;
  v_bin       record;
  v_take      numeric;
  v_task_id   uuid;
  v_tasks     int := 0;
  v_short     int := 0;
  v_replen    int := 0;
  v_task_ids  uuid[] := ARRAY[]::uuid[];
  v_readiness jsonb;
  v_priority  int;
  v_reserve   record;
BEGIN
  SELECT * INTO v_wave FROM public.wms_pick_waves WHERE id = p_wave_id FOR UPDATE;
  IF v_wave.id IS NULL THEN
    RAISE EXCEPTION 'wave % not found', p_wave_id USING ERRCODE = 'P0002';
  END IF;
  IF NOT user_can_access_business(auth.uid(), v_wave.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  IF v_wave.state = 'released' THEN
    RETURN jsonb_build_object('wave_id', p_wave_id, 'tasks_created', 0,
                              'task_ids', to_jsonb(ARRAY[]::uuid[]), 'noop', true);
  END IF;
  IF v_wave.state NOT IN ('draft','planned','ready') THEN
    RAISE EXCEPTION 'wave in state % cannot be released', v_wave.state USING ERRCODE = '22023';
  END IF;

  v_readiness := public.wms_wave_readiness(p_wave_id);
  IF v_readiness->>'state' = 'blocked' AND NOT p_force THEN
    RAISE EXCEPTION 'WAVE_NOT_READY: %', COALESCE(
      (SELECT string_agg(c->>'reason', '; ')
       FROM jsonb_array_elements(v_readiness->'checks') c
       WHERE c->>'state' = 'blocked'), 'wave is blocked')
      USING ERRCODE = '22023';
  END IF;

  v_priority := COALESCE(
    (SELECT s.task_priority FROM public.wms_wave_strategies s WHERE s.id = v_wave.strategy_id), 90);

  FOR v_line IN
    SELECT * FROM public.wms_pick_wave_lines WHERE wave_id = p_wave_id ORDER BY created_at
  LOOP
    v_remaining := GREATEST(COALESCE(v_line.quantity_ordered,0) - COALESCE(v_line.quantity_picked,0), 0);
    v_assigned  := 0;
    CONTINUE WHEN v_remaining <= 0;

    FOR v_bin IN
      SELECT sq.location_id, sq.lot_number,
             GREATEST(sq.quantity - COALESCE(sq.reserved_quantity,0), 0) AS available,
             sl.pick_sequence
      FROM public.stock_quants sq
      JOIN public.stock_locations sl ON sl.id = sq.location_id
      WHERE sq.product_id = v_line.product_id
        AND sl.warehouse_id = v_wave.warehouse_id
        AND sl.is_active = true
        AND COALESCE(sl.is_blocked, false) = false
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
        source_doc_type, source_doc_id, wave_id,
        source_location_id,
        product_id, lot_number, quantity,
        metadata, created_by
      ) VALUES (
        v_wave.organization_id, v_wave.business_id, v_wave.branch_id, v_wave.warehouse_id,
        'pick', 'pending', v_priority,
        'wms_pick_wave', p_wave_id, p_wave_id,
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

      v_tasks    := v_tasks + 1;
      v_task_ids := v_task_ids || v_task_id;
      v_remaining := v_remaining - v_take;
      v_assigned  := v_assigned + v_take;
    END LOOP;

    IF v_assigned > 0 THEN
      -- hand the hold over from the order to the wave, through the engine
      PERFORM public._wms_consume_order_reservation(v_line.sales_order_id, v_line.product_id, v_assigned);
      PERFORM public.reserve_stock_atomic(
        p_organization_id => v_wave.organization_id,
        p_product_id      => v_line.product_id,
        p_quantity        => v_assigned,
        p_source_type     => 'pick_wave',
        p_source_id       => p_wave_id,
        p_warehouse_id    => v_wave.warehouse_id,
        p_lot_number      => v_line.lot_number,
        p_allow_partial   => true,
        p_idempotency_key => 'pick_wave:' || p_wave_id::text || ':' || v_line.id::text,
        p_metadata        => jsonb_build_object('wave_line_id', v_line.id,
                                                'sales_order_id', v_line.sales_order_id)
      );
    END IF;

    IF v_remaining > 0 THEN
      SELECT sq.location_id,
             GREATEST(sq.quantity - COALESCE(sq.reserved_quantity,0), 0) AS available
        INTO v_reserve
      FROM public.stock_quants sq
      JOIN public.stock_locations sl ON sl.id = sq.location_id
      WHERE sq.product_id = v_line.product_id
        AND sl.warehouse_id = v_wave.warehouse_id
        AND sl.is_active
        AND COALESCE(sl.is_blocked,false) = false
        AND COALESCE(sl.is_receiving_staging,false) = true
        AND (sq.quantity - COALESCE(sq.reserved_quantity,0)) > 0
      ORDER BY (sq.quantity - COALESCE(sq.reserved_quantity,0)) DESC
      LIMIT 1;

      IF v_reserve.location_id IS NOT NULL THEN
        INSERT INTO public.wms_tasks (
          organization_id, business_id, branch_id, warehouse_id,
          task_type, state, priority,
          source_doc_type, source_doc_id, wave_id,
          source_location_id, product_id, lot_number, quantity, notes,
          metadata, created_by
        ) VALUES (
          v_wave.organization_id, v_wave.business_id, v_wave.branch_id, v_wave.warehouse_id,
          'replenishment', 'pending', GREATEST(v_priority - 10, 1),
          'wms_pick_wave', p_wave_id, p_wave_id,
          v_reserve.location_id, v_line.product_id, v_line.lot_number,
          LEAST(v_reserve.available, v_remaining),
          'wave replenishment: pick face short',
          jsonb_build_object('wave_id', p_wave_id, 'wave_line_id', v_line.id,
                             'replenishment', true),
          auth.uid()
        ) RETURNING id INTO v_task_id;
        v_tasks := v_tasks + 1;
        v_replen := v_replen + 1;
        v_task_ids := v_task_ids || v_task_id;
      END IF;

      INSERT INTO public.wms_tasks (
        organization_id, business_id, branch_id, warehouse_id,
        task_type, state, priority,
        source_doc_type, source_doc_id, wave_id,
        product_id, lot_number, quantity, notes,
        metadata, created_by
      ) VALUES (
        v_wave.organization_id, v_wave.business_id, v_wave.branch_id, v_wave.warehouse_id,
        'pick', 'pending', LEAST(v_priority + 5, 100),
        'wms_pick_wave', p_wave_id, p_wave_id,
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
      v_tasks    := v_tasks + 1;
      v_short    := v_short + 1;
      v_task_ids := v_task_ids || v_task_id;
    END IF;
  END LOOP;

  IF v_short > 0 THEN
    INSERT INTO public.wms_exceptions (
      organization_id, business_id, branch_id, warehouse_id,
      kind, state, severity, aggregate_type, aggregate_id, reason, details, raised_by
    ) VALUES (
      v_wave.organization_id, v_wave.business_id, v_wave.branch_id, v_wave.warehouse_id,
      'shortage', 'open', 'high', 'wms_pick_wave', p_wave_id,
      v_short || ' line(s) released short of stock',
      jsonb_build_object('short_tasks', v_short, 'replenishment_tasks', v_replen),
      auth.uid()
    );
  END IF;

  UPDATE public.wms_pick_waves
     SET state = 'released',
         released_at = now(),
         released_by = auth.uid(),
         readiness = v_readiness,
         readiness_checked_at = now(),
         row_version = row_version + 1
   WHERE id = p_wave_id;

  INSERT INTO public.wms_task_events (
    organization_id, business_id, branch_id, warehouse_id,
    task_id, task_type, event_type, to_state, actor_id,
    source_doc_type, source_doc_id, correlation_id, reason, payload
  )
  SELECT t.organization_id, t.business_id, t.branch_id, t.warehouse_id,
         t.id, t.task_type, 'wave_released', t.state, auth.uid(),
         'wms_pick_wave', p_wave_id, p_wave_id, 'wave release',
         jsonb_build_object('wave_number', v_wave.wave_number,
                            'short_pick', COALESCE((t.metadata->>'short_pick')::boolean, false))
  FROM public.wms_tasks t
  WHERE t.id = ANY(v_task_ids);

  PERFORM public._wms_emit_outbox(
    'warehouse.wave.released',
    'wms.wave:' || p_wave_id::text || ':released',
    v_wave.organization_id, v_wave.business_id,
    jsonb_build_object('aggregate_id', p_wave_id, 'warehouse_id', v_wave.warehouse_id,
                       'branch_id', v_wave.branch_id, 'actor_id', auth.uid(),
                       'occurred_at', now(), 'tasks', v_tasks,
                       'readiness', v_readiness->>'state')
  );

  RETURN jsonb_build_object('wave_id', p_wave_id, 'tasks_created', v_tasks,
                            'short_pick_tasks', v_short,
                            'replenishment_tasks', v_replen,
                            'readiness', v_readiness->>'state',
                            'task_ids', to_jsonb(v_task_ids));
END; $function$;

-- Wave cancellation: release wave holds, restore the order holds
CREATE OR REPLACE FUNCTION public._wms_unwind_cancelled_wave(p_wave_id uuid, p_reason text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_wave public.wms_pick_waves;
  v_line record;
  v_open numeric;
  v_cancelled int := 0;
  v_released jsonb;
  v_restored numeric := 0;
BEGIN
  SELECT * INTO v_wave FROM public.wms_pick_waves WHERE id = p_wave_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('unwound', false); END IF;

  v_cancelled := public._wms_finalize_source_tasks(
    'wms_pick_wave', p_wave_id, NULL, 'cancelled'::wms_task_state,
    COALESCE(p_reason, 'wave cancelled'));

  v_released := public.release_stock_reservations_for_source(
    v_wave.organization_id, 'pick_wave', p_wave_id, NULL,
    COALESCE(p_reason, 'wave cancelled'));

  FOR v_line IN
    SELECT * FROM public.wms_pick_wave_lines WHERE wave_id = p_wave_id
  LOOP
    v_open := GREATEST(COALESCE(v_line.quantity_ordered,0) - COALESCE(v_line.quantity_picked,0), 0);
    CONTINUE WHEN v_open <= 0 OR v_line.sales_order_id IS NULL;
    v_restored := v_restored + public.restore_so_reservation(
      v_wave.organization_id, v_line.sales_order_id, v_line.product_id, v_open);
  END LOOP;

  INSERT INTO public.wms_task_events (
    organization_id, business_id, branch_id, warehouse_id,
    task_id, task_type, event_type, to_state, actor_id,
    source_doc_type, source_doc_id, correlation_id, reason, payload
  )
  SELECT t.organization_id, t.business_id, t.branch_id, t.warehouse_id,
         t.id, t.task_type, 'wave_cancelled', t.state, auth.uid(),
         'wms_pick_wave', p_wave_id, p_wave_id, COALESCE(p_reason,'wave cancelled'),
         jsonb_build_object('wave_number', v_wave.wave_number)
  FROM public.wms_tasks t
  WHERE t.source_doc_type = 'wms_pick_wave' AND t.source_doc_id = p_wave_id;

  RETURN jsonb_build_object('unwound', true,
                            'cancelled_tasks', v_cancelled,
                            'reservations_released', COALESCE((v_released->>'released')::int, 0),
                            'quantity_restored_to_orders', v_restored);
END $function$;

-- Physical count freeze holds go through the engine too
CREATE OR REPLACE FUNCTION public.physical_count_freeze_scoped(
  p_count_id uuid, p_user_id uuid,
  p_product_ids uuid[] DEFAULT NULL::uuid[], p_line_seed jsonb DEFAULT NULL::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_c RECORD; v_lines int := 0; v_reservations int := 0; v_pcl RECORD; v_res jsonb;
BEGIN
  SELECT * INTO v_c FROM public.physical_counts WHERE id = p_count_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'physical count % not found', p_count_id USING ERRCODE='P0001'; END IF;
  IF v_c.state <> 'draft' THEN
    RAISE EXCEPTION 'cannot freeze count in state %', v_c.state USING ERRCODE='P0001';
  END IF;

  INSERT INTO public.physical_count_lines (
    count_id, organization_id, business_id, product_id, system_qty_at_freeze,
    unit_cost_snapshot, cost_source
  )
  SELECT p_count_id, v_c.organization_id, v_c.business_id, p.id,
         COALESCE(seed.system_qty, ws.quantity, 0),
         COALESCE(ws.average_cost, p.cost_price, 0),
         'wac'
    FROM public.products p
    LEFT JOIN public.warehouse_stock ws
      ON ws.product_id = p.id AND ws.warehouse_id = v_c.warehouse_id
    LEFT JOIN LATERAL (
      SELECT (e->>'system_qty')::numeric AS system_qty
        FROM jsonb_array_elements(COALESCE(p_line_seed, '[]'::jsonb)) e
       WHERE (e->>'product_id')::uuid = p.id
       LIMIT 1
    ) seed ON true
   WHERE p.organization_id = v_c.organization_id
     AND p.business_id = v_c.business_id
     AND p.track_inventory = true
     AND p.type = 'product'
     AND (p_product_ids IS NULL OR p.id = ANY(p_product_ids))
  ON CONFLICT (count_id, product_id, packaging_id, lot_id) DO NOTHING;

  GET DIAGNOSTICS v_lines = ROW_COUNT;

  INSERT INTO public.physical_count_freeze_movements (
    count_id, organization_id, warehouse_id, product_id, last_movement_id
  )
  SELECT p_count_id, v_c.organization_id, v_c.warehouse_id, pcl.product_id,
         (SELECT id FROM public.stock_movements sm
           WHERE sm.warehouse_id = v_c.warehouse_id
             AND sm.product_id = pcl.product_id
           ORDER BY sm.created_at DESC LIMIT 1)
    FROM public.physical_count_lines pcl
   WHERE pcl.count_id = p_count_id
  ON CONFLICT (count_id, warehouse_id, product_id) DO NOTHING;

  FOR v_pcl IN
    SELECT id, product_id, system_qty_at_freeze
      FROM public.physical_count_lines
     WHERE count_id = p_count_id AND system_qty_at_freeze > 0
  LOOP
    v_res := public.reserve_stock_atomic(
      p_organization_id => v_c.organization_id,
      p_product_id      => v_pcl.product_id,
      p_quantity        => v_pcl.system_qty_at_freeze,
      p_source_type     => 'physical_count',
      p_source_id       => p_count_id,
      p_warehouse_id    => v_c.warehouse_id,
      p_expires_at      => now() + interval '24 hours',
      p_allow_partial   => true,
      p_reserved_by     => p_user_id,
      p_idempotency_key => 'physical_count:' || p_count_id::text || ':' || v_pcl.id::text
    );
    IF COALESCE((v_res->>'success')::boolean, false) THEN
      v_reservations := v_reservations + 1;
    END IF;
  END LOOP;

  UPDATE public.physical_counts
     SET state = 'counting', frozen_at = now(), frozen_by = p_user_id
   WHERE id = p_count_id;

  INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
  VALUES (p_count_id, v_c.organization_id, 'frozen', p_user_id,
          jsonb_build_object(
            'lines_snapshotted', v_lines,
            'reservations_created', v_reservations,
            'scoped', p_product_ids IS NOT NULL
          ));

  RETURN jsonb_build_object('success', true, 'lines_snapshotted', v_lines, 'reservations_created', v_reservations);
END $function$;

-- Guard: reserved on quants is a projection, never a hand-written counter
CREATE OR REPLACE FUNCTION public._guard_quant_reserved_is_derived()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.reserved_quantity IS DISTINCT FROM OLD.reserved_quantity
     AND current_setting('app.quant_reserved_projection', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'INVENTORY_RESERVED_IS_DERIVED: stock_quants.reserved_quantity is projected from stock_reservations (ADR 0142)'
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.refresh_quant_reserved_projection(
  p_location_id uuid,
  p_product_id  uuid,
  p_lot_number  text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_reserved numeric := 0;
BEGIN
  IF p_location_id IS NULL OR p_product_id IS NULL THEN RETURN; END IF;

  SELECT COALESCE(SUM(r.quantity), 0)
    INTO v_reserved
    FROM public.stock_reservations r
   WHERE r.location_id = p_location_id
     AND r.product_id  = p_product_id
     AND r.lot_number IS NOT DISTINCT FROM p_lot_number
     AND public.stock_reservation_is_open(r.status, r.expires_at);

  PERFORM set_config('app.quant_reserved_projection', 'on', true);
  UPDATE public.stock_quants
     SET reserved_quantity = v_reserved,
         updated_at = now()
   WHERE location_id = p_location_id
     AND product_id  = p_product_id
     AND lot_number IS NOT DISTINCT FROM p_lot_number;
  PERFORM set_config('app.quant_reserved_projection', 'off', true);
END $function$;

DROP TRIGGER IF EXISTS trg_guard_quant_reserved ON public.stock_quants;
CREATE TRIGGER trg_guard_quant_reserved
BEFORE UPDATE ON public.stock_quants
FOR EACH ROW EXECUTE FUNCTION public._guard_quant_reserved_is_derived();
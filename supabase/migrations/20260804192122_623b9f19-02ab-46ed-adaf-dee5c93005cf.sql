-- =====================================================================
-- Phase 3 — Readiness engine. A wave may only be committed to the floor
-- when the floor can actually execute it: stock, labour, dock, cut-off.
-- The server owns the verdict; clients render it and never re-derive it.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.wms_wave_readiness(p_wave_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_wave        public.wms_pick_waves;
  v_lines       int := 0;
  v_short_lines int := 0;
  v_open_units  numeric := 0;
  v_cover_units numeric := 0;
  v_labour      record;
  v_need_sec    numeric;
  v_exceptions  int := 0;
  v_checks      jsonb := '[]'::jsonb;
  v_state       text := 'ready';

  PROCEDURE_placeholder boolean;
BEGIN
  SELECT * INTO v_wave FROM public.wms_pick_waves WHERE id = p_wave_id;
  IF v_wave.id IS NULL THEN
    RAISE EXCEPTION 'wave % not found', p_wave_id USING ERRCODE = 'P0002';
  END IF;
  PERFORM public._wms_assert_business_access(v_wave.business_id);

  -- 1. Stock coverage, line by line, against unreserved stock in this warehouse.
  SELECT count(*),
         count(*) FILTER (WHERE cover.available < l.qty_open),
         COALESCE(sum(l.qty_open), 0),
         COALESCE(sum(LEAST(l.qty_open, cover.available)), 0)
    INTO v_lines, v_short_lines, v_open_units, v_cover_units
  FROM (
    SELECT wl.product_id, wl.lot_number,
           GREATEST(COALESCE(wl.quantity_ordered,0) - COALESCE(wl.quantity_picked,0), 0) AS qty_open
    FROM public.wms_pick_wave_lines wl
    WHERE wl.wave_id = p_wave_id
  ) l
  JOIN LATERAL (
    SELECT COALESCE(sum(GREATEST(sq.quantity - COALESCE(sq.reserved_quantity,0), 0)), 0) AS available
    FROM public.stock_quants sq
    JOIN public.stock_locations sl ON sl.id = sq.location_id
    WHERE sq.product_id = l.product_id
      AND sl.warehouse_id = v_wave.warehouse_id
      AND sl.is_active
      AND COALESCE(sl.is_blocked, false) = false
      AND COALESCE(sl.is_receiving_staging, false) = false
      AND (l.lot_number IS NULL OR sq.lot_number = l.lot_number)
  ) cover ON true;

  v_checks := v_checks || jsonb_build_object(
    'check', 'stock',
    'state', CASE WHEN v_lines = 0 THEN 'blocked'
                  WHEN v_cover_units <= 0 THEN 'blocked'
                  WHEN v_short_lines > 0 THEN 'at_risk'
                  ELSE 'ready' END,
    'detail', jsonb_build_object(
      'lines', v_lines, 'short_lines', v_short_lines,
      'open_units', v_open_units, 'covered_units', v_cover_units,
      'coverage_pct', CASE WHEN v_open_units > 0
                           THEN ROUND(100 * v_cover_units / v_open_units, 1) ELSE 0 END),
    'reason', CASE WHEN v_lines = 0 THEN 'wave has no open lines'
                   WHEN v_cover_units <= 0 THEN 'no pickable stock for any line'
                   WHEN v_short_lines > 0 THEN v_short_lines || ' line(s) short' END
  );

  -- 2. Labour. Compare the wave's estimated work against today's plan gap.
  SELECT * INTO v_labour
  FROM public.wms_labour_plan(v_wave.warehouse_id, current_date, current_date) LIMIT 1;

  v_need_sec := COALESCE(v_wave.estimated_pick_minutes, v_lines * 1.5) * 60;

  v_checks := v_checks || jsonb_build_object(
    'check', 'labour',
    'state', CASE
      WHEN v_labour IS NULL OR COALESCE(v_labour.planned_operators, 0) = 0 THEN 'at_risk'
      WHEN COALESCE(v_labour.planned_seconds, 0) - COALESCE(v_labour.required_seconds, 0) < v_need_sec THEN 'at_risk'
      ELSE 'ready' END,
    'detail', jsonb_build_object(
      'required_seconds', v_need_sec,
      'planned_seconds', COALESCE(v_labour.planned_seconds, 0),
      'committed_seconds', COALESCE(v_labour.required_seconds, 0),
      'planned_operators', COALESCE(v_labour.planned_operators, 0)),
    'reason', CASE
      WHEN v_labour IS NULL OR COALESCE(v_labour.planned_operators, 0) = 0
        THEN 'no operators planned for today'
      WHEN COALESCE(v_labour.planned_seconds,0) - COALESCE(v_labour.required_seconds,0) < v_need_sec
        THEN 'planned labour does not cover this wave on top of committed work' END
  );

  -- 3. Departure. A wave that serves no dock or appointment is a plan
  --    without an exit; a wave whose cut-off has passed is already late.
  v_checks := v_checks || jsonb_build_object(
    'check', 'departure',
    'state', CASE
      WHEN v_wave.cutoff_at IS NOT NULL AND v_wave.cutoff_at < now() THEN 'blocked'
      WHEN v_wave.dock_id IS NULL AND v_wave.appointment_id IS NULL THEN 'at_risk'
      WHEN v_wave.cutoff_at IS NOT NULL
           AND v_wave.cutoff_at < now() + (COALESCE(v_wave.estimated_pick_minutes,0) || ' minutes')::interval
        THEN 'at_risk'
      ELSE 'ready' END,
    'detail', jsonb_build_object(
      'dock_id', v_wave.dock_id, 'appointment_id', v_wave.appointment_id,
      'cutoff_at', v_wave.cutoff_at, 'carrier_id', v_wave.carrier_id),
    'reason', CASE
      WHEN v_wave.cutoff_at IS NOT NULL AND v_wave.cutoff_at < now() THEN 'cut-off has passed'
      WHEN v_wave.dock_id IS NULL AND v_wave.appointment_id IS NULL THEN 'no dock or appointment assigned'
      WHEN v_wave.cutoff_at IS NOT NULL
           AND v_wave.cutoff_at < now() + (COALESCE(v_wave.estimated_pick_minutes,0) || ' minutes')::interval
        THEN 'estimated pick time runs past the cut-off' END
  );

  -- 4. Open exceptions already raised against this wave.
  SELECT count(*) INTO v_exceptions
  FROM public.wms_exceptions e
  WHERE e.aggregate_type = 'wms_pick_wave'
    AND e.aggregate_id = p_wave_id
    AND e.state NOT IN ('resolved','cancelled');

  v_checks := v_checks || jsonb_build_object(
    'check', 'exceptions',
    'state', CASE WHEN v_exceptions > 0 THEN 'at_risk' ELSE 'ready' END,
    'detail', jsonb_build_object('open', v_exceptions),
    'reason', CASE WHEN v_exceptions > 0 THEN v_exceptions || ' open exception(s)' END
  );

  -- Worst check wins.
  SELECT CASE
    WHEN bool_or(c->>'state' = 'blocked') THEN 'blocked'
    WHEN bool_or(c->>'state' = 'at_risk') THEN 'at_risk'
    ELSE 'ready' END
  INTO v_state
  FROM jsonb_array_elements(v_checks) c;

  RETURN jsonb_build_object(
    'wave_id', p_wave_id,
    'state', v_state,
    'checked_at', now(),
    'checks', v_checks
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.wms_wave_readiness(uuid) TO authenticated;

-- Persist the verdict so boards and alerting read one snapshot.
CREATE OR REPLACE FUNCTION public.wms_evaluate_wave(p_wave_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_result jsonb;
  v_state  text;
  v_wave   public.wms_pick_waves;
BEGIN
  SELECT * INTO v_wave FROM public.wms_pick_waves WHERE id = p_wave_id FOR UPDATE;
  IF v_wave.id IS NULL THEN
    RAISE EXCEPTION 'wave % not found', p_wave_id USING ERRCODE = 'P0002';
  END IF;
  PERFORM public._wms_assert_business_access(v_wave.business_id);

  v_result := public.wms_wave_readiness(p_wave_id);
  v_state  := v_result->>'state';

  UPDATE public.wms_pick_waves
     SET readiness = v_result,
         readiness_checked_at = now(),
         -- Planning states track the verdict; execution states never regress.
         state = CASE
           WHEN state IN ('draft','planned','ready') AND v_state = 'ready' THEN 'ready'::wms_wave_state
           WHEN state = 'ready' AND v_state <> 'ready' THEN 'planned'::wms_wave_state
           ELSE state END,
         updated_at = now()
   WHERE id = p_wave_id;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.wms_evaluate_wave(uuid) TO authenticated;

-- =====================================================================
-- Phase 3b — lifecycle. The FSM learns the planning states, suspension
-- and closure. Release still belongs to release_pick_wave.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.wms_transition_wave(
  p_wave_id uuid,
  p_to_state wms_wave_state,
  p_row_version integer,
  p_reason text DEFAULT NULL::text,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.wms_pick_waves%ROWTYPE;
  v_from wms_wave_state;
  v_allowed boolean := false;
  v_new_rv integer;
  v_unwind jsonb := '{}'::jsonb;
  v_resume wms_wave_state;
BEGIN
  SELECT * INTO v_row FROM public.wms_pick_waves WHERE id = p_wave_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pick wave not found' USING ERRCODE = 'P0002'; END IF;
  IF v_row.row_version <> p_row_version THEN
    RAISE EXCEPTION 'Row version mismatch (have %, expected %)', v_row.row_version, p_row_version USING ERRCODE = '40001';
  END IF;
  v_from := v_row.state;

  IF p_to_state = 'released' THEN
    RAISE EXCEPTION 'Release a wave through release_pick_wave so pick tasks and reservations are generated'
      USING ERRCODE = '22023';
  END IF;

  IF p_to_state = 'ready' AND COALESCE(v_row.readiness->>'state', 'unknown') <> 'ready' THEN
    RAISE EXCEPTION 'Wave is not ready: %', COALESCE(v_row.readiness->>'state', 'never evaluated')
      USING ERRCODE = '22023';
  END IF;

  v_allowed := CASE
    WHEN v_from = 'draft'     AND p_to_state IN ('planned','cancelled')          THEN true
    WHEN v_from = 'planned'   AND p_to_state IN ('ready','draft','cancelled')    THEN true
    WHEN v_from = 'ready'     AND p_to_state IN ('planned','cancelled')          THEN true
    WHEN v_from = 'released'  AND p_to_state IN ('picking','suspended','cancelled') THEN true
    WHEN v_from = 'picking'   AND p_to_state IN ('picked','suspended','cancelled')  THEN true
    WHEN v_from = 'picked'    AND p_to_state IN ('packing','suspended','cancelled') THEN true
    WHEN v_from = 'packing'   AND p_to_state IN ('packed','suspended','cancelled')  THEN true
    WHEN v_from = 'packed'    AND p_to_state IN ('completed','cancelled')        THEN true
    WHEN v_from = 'completed' AND p_to_state = 'archived'                        THEN true
    WHEN v_from = 'cancelled' AND p_to_state = 'archived'                        THEN true
    WHEN v_from = 'suspended' AND p_to_state IN ('released','picking','picked','packing','cancelled') THEN true
    ELSE false
  END;

  -- Suspension is reversible: resuming returns to the state it left.
  IF v_from = 'suspended' AND p_to_state <> 'cancelled' THEN
    v_resume := COALESCE((v_row.readiness->>'suspended_from')::wms_wave_state, p_to_state);
    v_allowed := true;
  END IF;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Illegal wave transition % → %', v_from, p_to_state USING ERRCODE = '22023';
  END IF;

  IF p_to_state = 'cancelled' THEN
    v_unwind := public._wms_unwind_cancelled_wave(p_wave_id, p_reason);
  END IF;

  v_new_rv := v_row.row_version + 1;
  UPDATE public.wms_pick_waves SET
    state        = p_to_state,
    row_version  = v_new_rv,
    suspended_reason = CASE WHEN p_to_state = 'suspended' THEN p_reason ELSE NULL END,
    readiness    = CASE WHEN p_to_state = 'suspended'
                        THEN COALESCE(readiness,'{}'::jsonb)
                             || jsonb_build_object('suspended_from', v_from::text)
                        ELSE readiness END,
    completed_at = COALESCE(completed_at,
                     CASE WHEN p_to_state IN ('packed','completed','cancelled') THEN now() END),
    updated_at   = now()
  WHERE id = p_wave_id;

  PERFORM public._wms_emit_outbox(
    'warehouse.wave.' || p_to_state::text,
    'wms.wave:' || p_wave_id::text || ':' || p_to_state::text,
    v_row.organization_id, v_row.business_id,
    jsonb_build_object(
      'aggregate_id', p_wave_id, 'warehouse_id', v_row.warehouse_id, 'branch_id', v_row.branch_id,
      'actor_id', auth.uid(), 'occurred_at', now(),
      'from_state', v_from, 'to_state', p_to_state,
      'reason', p_reason, 'extra', COALESCE(p_payload, '{}'::jsonb)
    )
  );

  RETURN jsonb_build_object('row_version', v_new_rv, 'state', p_to_state) || v_unwind;
END;
$function$;

-- =====================================================================
-- Phase 4 — release becomes the commitment gate: it evaluates readiness,
-- refuses a blocked wave unless forced, stamps the wave on every task it
-- creates, and raises replenishment work instead of silent short picks.
-- =====================================================================
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

  -- Readiness gate. Blocked means the floor cannot execute this wave.
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
      PERFORM public._wms_consume_order_reservation(v_line.sales_order_id, v_line.product_id, v_assigned);
      INSERT INTO public.stock_reservations (
        organization_id, business_id, branch_id, warehouse_id,
        product_id, quantity, source_type, source_id, reserved_by
      ) VALUES (
        v_wave.organization_id, v_wave.business_id, v_wave.branch_id, v_wave.warehouse_id,
        v_line.product_id, v_assigned,
        'pick_wave', p_wave_id, auth.uid()
      );
    END IF;

    IF v_remaining > 0 THEN
      -- Is the shortfall merely in the wrong place? If reserve stock exists in
      -- a non-pickable location, ask for replenishment rather than a hunt.
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

  -- A shortage is an exception the tower must see, not a quiet task.
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

GRANT EXECUTE ON FUNCTION public.release_pick_wave(uuid, boolean) TO authenticated;
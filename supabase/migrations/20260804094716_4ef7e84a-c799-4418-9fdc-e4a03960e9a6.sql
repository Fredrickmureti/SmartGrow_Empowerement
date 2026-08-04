-- Phase 4.3 — reservation-consistent wave release / cancel.

CREATE OR REPLACE FUNCTION public._wms_consume_order_reservation(
  p_sales_order_id uuid,
  p_product_id uuid,
  p_qty numeric
) RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_left numeric := COALESCE(p_qty, 0);
  v_take numeric;
  r record;
BEGIN
  IF p_sales_order_id IS NULL OR v_left <= 0 THEN RETURN 0; END IF;

  FOR r IN
    SELECT id, quantity
    FROM public.stock_reservations
    WHERE source_type = 'sales_order'
      AND source_id = p_sales_order_id
      AND product_id = p_product_id
      AND released_at IS NULL
    ORDER BY created_at
    FOR UPDATE
  LOOP
    EXIT WHEN v_left <= 0;
    v_take := LEAST(r.quantity, v_left);
    IF v_take >= r.quantity THEN
      UPDATE public.stock_reservations SET released_at = now() WHERE id = r.id;
    ELSE
      UPDATE public.stock_reservations SET quantity = quantity - v_take WHERE id = r.id;
    END IF;
    v_left := v_left - v_take;
  END LOOP;

  RETURN COALESCE(p_qty,0) - v_left;
END $function$;

REVOKE ALL ON FUNCTION public._wms_consume_order_reservation(uuid, uuid, numeric) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.release_pick_wave(p_wave_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_wave     record;
  v_line     record;
  v_remaining numeric;
  v_assigned  numeric;
  v_bin      record;
  v_take     numeric;
  v_task_id  uuid;
  v_tasks    int := 0;
  v_short    int := 0;
  v_task_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  -- Lock the wave: two concurrent releases must not both emit tasks.
  SELECT * INTO v_wave FROM public.wms_pick_waves WHERE id = p_wave_id FOR UPDATE;
  IF v_wave.id IS NULL THEN
    RAISE EXCEPTION 'wave % not found', p_wave_id USING ERRCODE = 'P0002';
  END IF;
  IF NOT user_can_access_business(auth.uid(), v_wave.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  -- Idempotent: releasing an already-released wave is a no-op, not an error.
  IF v_wave.state <> 'draft' THEN
    IF v_wave.state = 'released' THEN
      RETURN jsonb_build_object('wave_id', p_wave_id, 'tasks_created', 0,
                                'task_ids', to_jsonb(ARRAY[]::uuid[]), 'noop', true);
    END IF;
    RAISE EXCEPTION 'wave in state % cannot be released', v_wave.state USING ERRCODE = '22023';
  END IF;

  FOR v_line IN
    SELECT * FROM public.wms_pick_wave_lines WHERE wave_id = p_wave_id ORDER BY created_at
  LOOP
    v_remaining := GREATEST(COALESCE(v_line.quantity_ordered,0) - COALESCE(v_line.quantity_picked,0), 0);
    v_assigned  := 0;
    CONTINUE WHEN v_remaining <= 0;

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

      v_tasks    := v_tasks + 1;
      v_task_ids := v_task_ids || v_task_id;
      v_remaining := v_remaining - v_take;
      v_assigned  := v_assigned + v_take;
    END LOOP;

    -- Reservation ownership moves from the sales order to the wave for the
    -- quantity we actually committed to bins. The short-pick remainder stays
    -- reserved against the order (there is no stock to hold for it).
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
      v_tasks    := v_tasks + 1;
      v_short    := v_short + 1;
      v_task_ids := v_task_ids || v_task_id;
    END IF;
  END LOOP;

  UPDATE public.wms_pick_waves
     SET state = 'released', released_at = now()
   WHERE id = p_wave_id;

  -- Execution ledger: the release decision itself is auditable per task.
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

  RETURN jsonb_build_object('wave_id', p_wave_id, 'tasks_created', v_tasks,
                            'short_pick_tasks', v_short, 'task_ids', to_jsonb(v_task_ids));
END; $function$;

CREATE OR REPLACE FUNCTION public.cancel_pick_wave(p_wave_id uuid, p_reason text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_wave public.wms_pick_waves;
  v_task record;
  v_line record;
  v_open numeric;
  v_cancelled_tasks int := 0;
  v_released_res int := 0;
  v_restored numeric := 0;
BEGIN
  SELECT * INTO v_wave FROM public.wms_pick_waves WHERE id = p_wave_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wms_pick_wave % not found', p_wave_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM public._wms_assert_business_access(v_wave.business_id);

  IF v_wave.state = 'cancelled' THEN
    RETURN jsonb_build_object('wave_id', v_wave.id, 'state', 'cancelled', 'noop', true);
  END IF;

  IF v_wave.state NOT IN ('draft','released') THEN
    RAISE EXCEPTION 'cannot cancel wave in state %', v_wave.state USING ERRCODE = '22023';
  END IF;

  -- Cancel open tasks through the FSM. claimed/in_progress have no direct
  -- edge to cancelled, so they route through `exception` first.
  FOR v_task IN
    SELECT id, state, row_version
    FROM public.wms_tasks
    WHERE task_type = 'pick'
      AND source_doc_type = 'wms_pick_wave'
      AND source_doc_id = p_wave_id
      AND state IN ('pending','available','claimed','in_progress','paused','exception')
    FOR UPDATE
  LOOP
    IF v_task.state IN ('claimed','in_progress') THEN
      PERFORM public.wms_transition_task(v_task.id, 'exception'::wms_task_state, v_task.row_version,
                                         auth.uid(), COALESCE(p_reason,'wave cancelled'));
      PERFORM public.wms_transition_task(v_task.id, 'cancelled'::wms_task_state, v_task.row_version + 1,
                                         auth.uid(), COALESCE(p_reason,'wave cancelled'));
    ELSE
      PERFORM public.wms_transition_task(v_task.id, 'cancelled'::wms_task_state, v_task.row_version,
                                         auth.uid(), COALESCE(p_reason,'wave cancelled'));
    END IF;
    v_cancelled_tasks := v_cancelled_tasks + 1;
  END LOOP;

  -- Release the wave's own reservations and hand the unpicked demand back
  -- to the sales order so allocation is never silently lost.
  UPDATE public.stock_reservations
     SET released_at = now()
   WHERE source_type = 'pick_wave'
     AND source_id = p_wave_id
     AND released_at IS NULL;
  GET DIAGNOSTICS v_released_res = ROW_COUNT;

  FOR v_line IN
    SELECT * FROM public.wms_pick_wave_lines WHERE wave_id = p_wave_id
  LOOP
    v_open := GREATEST(COALESCE(v_line.quantity_ordered,0) - COALESCE(v_line.quantity_picked,0), 0);
    CONTINUE WHEN v_open <= 0 OR v_line.sales_order_id IS NULL;
    INSERT INTO public.stock_reservations (
      organization_id, business_id, branch_id, warehouse_id,
      product_id, quantity, source_type, source_id, reserved_by
    ) VALUES (
      v_wave.organization_id, v_wave.business_id, v_wave.branch_id, v_wave.warehouse_id,
      v_line.product_id, v_open, 'sales_order', v_line.sales_order_id, auth.uid()
    );
    v_restored := v_restored + v_open;
  END LOOP;

  UPDATE public.wms_pick_waves
     SET state = 'cancelled',
         notes = COALESCE(notes,'') || CASE WHEN p_reason IS NULL THEN '' ELSE E'\ncancel: ' || p_reason END,
         updated_at = now()
   WHERE id = p_wave_id;

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

  RETURN jsonb_build_object('wave_id', v_wave.id, 'state', 'cancelled',
                            'cancelled_tasks', v_cancelled_tasks,
                            'reservations_released', v_released_res,
                            'quantity_restored_to_orders', v_restored);
END $function$;
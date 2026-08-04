-- Shared unwind used by every cancel path for a pick wave.
CREATE OR REPLACE FUNCTION public._wms_unwind_cancelled_wave(p_wave_id uuid, p_reason text DEFAULT NULL)
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
  v_cancelled int := 0;
  v_released int := 0;
  v_restored numeric := 0;
BEGIN
  SELECT * INTO v_wave FROM public.wms_pick_waves WHERE id = p_wave_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('unwound', false); END IF;

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
    ELSIF v_task.state = 'paused' THEN
      PERFORM public.wms_transition_task(v_task.id, 'cancelled'::wms_task_state, v_task.row_version,
                                         auth.uid(), COALESCE(p_reason,'wave cancelled'));
    ELSE
      PERFORM public.wms_transition_task(v_task.id, 'cancelled'::wms_task_state, v_task.row_version,
                                         auth.uid(), COALESCE(p_reason,'wave cancelled'));
    END IF;
    v_cancelled := v_cancelled + 1;
  END LOOP;

  UPDATE public.stock_reservations
     SET released_at = now()
   WHERE source_type = 'pick_wave'
     AND source_id = p_wave_id
     AND released_at IS NULL;
  GET DIAGNOSTICS v_released = ROW_COUNT;

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
                            'reservations_released', v_released,
                            'quantity_restored_to_orders', v_restored);
END $function$;

REVOKE ALL ON FUNCTION public._wms_unwind_cancelled_wave(uuid, text) FROM PUBLIC;

-- cancel_pick_wave now delegates the unwind.
CREATE OR REPLACE FUNCTION public.cancel_pick_wave(p_wave_id uuid, p_reason text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_wave public.wms_pick_waves;
  v_unwind jsonb;
BEGIN
  SELECT * INTO v_wave FROM public.wms_pick_waves WHERE id = p_wave_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wms_pick_wave % not found', p_wave_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM public._wms_assert_business_access(v_wave.business_id);

  IF v_wave.state = 'cancelled' THEN
    RETURN jsonb_build_object('wave_id', v_wave.id, 'state', 'cancelled', 'noop', true);
  END IF;
  IF v_wave.state NOT IN ('draft','released','picking','picked','packing') THEN
    RAISE EXCEPTION 'cannot cancel wave in state %', v_wave.state USING ERRCODE = '22023';
  END IF;

  v_unwind := public._wms_unwind_cancelled_wave(p_wave_id, p_reason);

  UPDATE public.wms_pick_waves
     SET state = 'cancelled',
         completed_at = COALESCE(completed_at, now()),
         notes = COALESCE(notes,'') || CASE WHEN p_reason IS NULL THEN '' ELSE E'\ncancel: ' || p_reason END,
         updated_at = now()
   WHERE id = p_wave_id;

  RETURN jsonb_build_object('wave_id', v_wave.id, 'state', 'cancelled') || v_unwind;
END $function$;

-- The generic aggregate FSM must unwind too: the supervisor cancel button
-- routes through here, and release must stay owned by release_pick_wave.
CREATE OR REPLACE FUNCTION public.wms_transition_wave(p_wave_id uuid, p_to_state wms_wave_state, p_row_version integer, p_reason text DEFAULT NULL::text, p_payload jsonb DEFAULT '{}'::jsonb)
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

  v_allowed := CASE
    WHEN v_from = 'draft'    AND p_to_state = 'cancelled'                THEN true
    WHEN v_from = 'released' AND p_to_state IN ('picking','cancelled')   THEN true
    WHEN v_from = 'picking'  AND p_to_state IN ('picked','cancelled')    THEN true
    WHEN v_from = 'picked'   AND p_to_state IN ('packing','cancelled')   THEN true
    WHEN v_from = 'packing'  AND p_to_state IN ('packed','cancelled')    THEN true
    ELSE false
  END;
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
    completed_at = COALESCE(completed_at, CASE WHEN p_to_state IN ('packed','cancelled') THEN now() END),
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
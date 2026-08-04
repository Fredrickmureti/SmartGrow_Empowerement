CREATE OR REPLACE FUNCTION public.complete_putaway_task(p_task_id uuid, p_location_id uuid DEFAULT NULL, p_override_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_task record;
  v_dest uuid;
  v_fit jsonb;
  v_overridden boolean := false;
  v_moved boolean := false;
BEGIN
  SELECT * INTO v_task FROM public.wms_tasks WHERE id = p_task_id;
  IF v_task.id IS NULL THEN RAISE EXCEPTION 'task % not found', p_task_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_task.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF v_task.task_type <> 'putaway' THEN RAISE EXCEPTION 'task is not putaway'; END IF;
  IF v_task.state NOT IN ('claimed','in_progress','pending') THEN
    RAISE EXCEPTION 'task in state % cannot be completed', v_task.state;
  END IF;

  -- A task that carries inventory but lost its license plate is a data fault:
  -- fail loudly with an actionable message rather than silently completing.
  IF v_task.lpn_id IS NULL AND v_task.product_id IS NOT NULL THEN
    RAISE EXCEPTION 'WMS_PUTAWAY_NO_LPN: this task has stock but no license plate. Scan/attach an LPN or raise an exception.';
  END IF;

  v_dest := COALESCE(p_location_id, v_task.destination_location_id);
  IF v_dest IS NULL THEN RAISE EXCEPTION 'task has no destination'; END IF;

  PERFORM 1 FROM public.stock_locations
   WHERE id = v_dest AND warehouse_id = v_task.warehouse_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'destination bin is not in this warehouse'; END IF;

  IF v_task.product_id IS NOT NULL THEN
    v_fit := public.wms_location_feasible(
      v_dest, v_task.product_id, COALESCE(v_task.quantity, 0), v_task.lot_number);

    IF NOT (v_fit->>'feasible')::boolean
       OR COALESCE((v_fit->>'feasible_qty')::numeric, 0) < COALESCE(v_task.quantity, 0) THEN
      IF p_override_reason IS NULL OR btrim(p_override_reason) = '' THEN
        RAISE EXCEPTION 'destination rejected: %', COALESCE(v_fit->>'reason', 'insufficient capacity');
      END IF;
      v_overridden := true;
    END IF;
  END IF;

  IF v_task.lpn_id IS NOT NULL THEN
    PERFORM public.wms_lpn_move(
      v_task.lpn_id, v_dest, NULL, 'putaway task ' || p_task_id::text);
    v_moved := true;
  END IF;

  UPDATE public.wms_tasks
     SET state = 'completed',
         destination_location_id = v_dest,
         completed_at = now(),
         started_at = COALESCE(started_at, now()),
         assignee_user_id = COALESCE(assignee_user_id, auth.uid()),
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'suggested_location_id', v_task.destination_location_id,
           'final_location_id', v_dest,
           'deviated', (v_task.destination_location_id IS DISTINCT FROM v_dest),
           'override_reason', p_override_reason,
           'override_applied', v_overridden,
           'movement', CASE WHEN v_moved THEN 'lpn_move' ELSE 'none' END,
           'feasibility', v_fit
         )
   WHERE id = p_task_id;

  RETURN jsonb_build_object(
    'task_id', p_task_id, 'state', 'completed',
    'location_id', v_dest, 'moved', v_moved, 'override_applied', v_overridden);
END;
$fn$;
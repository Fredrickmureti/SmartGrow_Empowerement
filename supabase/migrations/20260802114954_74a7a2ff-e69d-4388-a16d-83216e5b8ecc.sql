CREATE OR REPLACE FUNCTION public.complete_putaway_task(p_task_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
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

  -- Canonical plate move: relocates the plate, its quants and nested
  -- children, and writes the handling-unit event ledger entry.
  PERFORM public.wms_lpn_move(
    v_task.lpn_id,
    v_task.destination_location_id,
    NULL,
    'putaway task ' || p_task_id::text
  );

  UPDATE public.wms_tasks
     SET state = 'done', completed_at = now(),
         started_at = COALESCE(started_at, now()),
         assignee_user_id = COALESCE(assignee_user_id, auth.uid())
   WHERE id = p_task_id;

  RETURN jsonb_build_object('task_id', p_task_id, 'state', 'done');
END; $function$;

DROP FUNCTION IF EXISTS public.move_lpn(uuid, uuid, text);
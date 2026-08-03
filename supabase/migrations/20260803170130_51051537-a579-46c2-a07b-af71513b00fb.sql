-- Phase 5 — yard jockey work-order RPCs.

CREATE OR REPLACE FUNCTION public.request_yard_move(
  p_visit_id uuid,
  p_to_slot_id uuid DEFAULT NULL,
  p_to_dock_id uuid DEFAULT NULL,
  p_priority integer DEFAULT 100,
  p_notes text DEFAULT NULL
)
RETURNS public.wms_tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_visit public.wms_trailer_visits;
  v_task public.wms_tasks;
BEGIN
  SELECT * INTO v_visit FROM public.wms_trailer_visits WHERE id = p_visit_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'trailer visit not found'; END IF;
  IF v_visit.business_id NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF v_visit.status IN ('departed','no_show') THEN
    RAISE EXCEPTION 'visit already closed (status=%)', v_visit.status;
  END IF;
  IF (p_to_slot_id IS NULL) = (p_to_dock_id IS NULL) THEN
    RAISE EXCEPTION 'a yard move needs exactly one destination: a yard slot or a dock';
  END IF;

  IF p_to_slot_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.wms_yard_slots
     WHERE id = p_to_slot_id AND warehouse_id = v_visit.warehouse_id
  ) THEN
    RAISE EXCEPTION 'yard slot not found in this warehouse';
  END IF;
  IF p_to_dock_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.warehouse_docks
     WHERE id = p_to_dock_id AND warehouse_id = v_visit.warehouse_id
  ) THEN
    RAISE EXCEPTION 'dock not found in this warehouse';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.wms_tasks
     WHERE task_type = 'yard_move'
       AND (payload->>'visit_id') = p_visit_id::text
       AND state NOT IN ('done','completed','cancelled')
  ) THEN
    RAISE EXCEPTION 'this trailer already has an open yard move';
  END IF;

  INSERT INTO public.wms_tasks (
    organization_id, business_id, branch_id, warehouse_id, task_type, state,
    priority, source_doc_type, source_doc_id, notes, created_by, payload
  ) VALUES (
    v_visit.organization_id, v_visit.business_id, v_visit.branch_id, v_visit.warehouse_id,
    'yard_move', 'pending', COALESCE(p_priority, 100),
    'wms_trailer_visit', p_visit_id, NULLIF(btrim(COALESCE(p_notes,'')), ''), auth.uid(),
    jsonb_build_object(
      'visit_id', p_visit_id,
      'trailer_ref', v_visit.trailer_ref,
      'from_slot_id', v_visit.yard_slot_id,
      'from_dock_id', v_visit.dock_id,
      'to_slot_id', p_to_slot_id,
      'to_dock_id', p_to_dock_id
    )
  ) RETURNING * INTO v_task;

  PERFORM public.emit_yard_event('warehouse.yard.move_requested', v_visit);
  RETURN v_task;
END $$;

CREATE OR REPLACE FUNCTION public.complete_yard_move(
  p_task_id uuid,
  p_confirmed_code text DEFAULT NULL
)
RETURNS public.wms_trailer_visits
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_task public.wms_tasks;
  v_visit public.wms_trailer_visits;
  v_to_slot uuid;
  v_to_dock uuid;
  v_expected text;
BEGIN
  SELECT * INTO v_task FROM public.wms_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'task not found'; END IF;
  IF v_task.task_type <> 'yard_move' THEN RAISE EXCEPTION 'not a yard move task'; END IF;
  IF v_task.state IN ('done','completed','cancelled') THEN RAISE EXCEPTION 'yard move already closed'; END IF;
  IF v_task.business_id NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  v_to_slot := NULLIF(v_task.payload->>'to_slot_id','')::uuid;
  v_to_dock := NULLIF(v_task.payload->>'to_dock_id','')::uuid;

  -- Scan confirmation: when the operator scans a destination code it must
  -- match the dispatched destination.
  IF NULLIF(btrim(COALESCE(p_confirmed_code,'')), '') IS NOT NULL THEN
    IF v_to_slot IS NOT NULL THEN
      SELECT code INTO v_expected FROM public.wms_yard_slots WHERE id = v_to_slot;
    ELSE
      SELECT code INTO v_expected FROM public.warehouse_docks WHERE id = v_to_dock;
    END IF;
    IF upper(btrim(p_confirmed_code)) <> upper(COALESCE(v_expected,'')) THEN
      RAISE EXCEPTION 'wrong destination scanned: expected %', COALESCE(v_expected,'?');
    END IF;
  END IF;

  IF v_to_slot IS NOT NULL THEN
    v_visit := public.relocate_trailer((v_task.payload->>'visit_id')::uuid, v_to_slot, v_task.notes);
  ELSE
    v_visit := public.assign_trailer_to_dock((v_task.payload->>'visit_id')::uuid, v_to_dock);
  END IF;

  UPDATE public.wms_tasks
     SET state = 'completed',
         completed_at = now(),
         row_version = row_version + 1,
         updated_at = now()
   WHERE id = p_task_id;

  RETURN v_visit;
END $$;

CREATE OR REPLACE FUNCTION public.cancel_yard_move(
  p_task_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS public.wms_tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_task public.wms_tasks;
BEGIN
  SELECT * INTO v_task FROM public.wms_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'task not found'; END IF;
  IF v_task.task_type <> 'yard_move' THEN RAISE EXCEPTION 'not a yard move task'; END IF;
  IF v_task.business_id NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF v_task.state IN ('done','completed','cancelled') THEN RAISE EXCEPTION 'yard move already closed'; END IF;

  UPDATE public.wms_tasks
     SET state = 'cancelled',
         cancel_reason = NULLIF(btrim(COALESCE(p_reason,'')), ''),
         row_version = row_version + 1,
         updated_at = now()
   WHERE id = p_task_id
   RETURNING * INTO v_task;

  RETURN v_task;
END $$;

GRANT EXECUTE ON FUNCTION public.request_yard_move(uuid, uuid, uuid, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_yard_move(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_yard_move(uuid, text) TO authenticated;

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

  BEGIN
    PERFORM public._wms_emit_outbox(
      'warehouse.yard.move_requested',
      'trailer_visit', v_visit.id,
      jsonb_build_object(
        'trailer_visit_id', v_visit.id,
        'task_id', v_task.id,
        'warehouse_id', v_visit.warehouse_id,
        'business_id', v_visit.business_id,
        'trailer_ref', v_visit.trailer_ref,
        'to_slot_id', p_to_slot_id,
        'to_dock_id', p_to_dock_id
      ),
      v_visit.organization_id, v_visit.branch_id, v_visit.warehouse_id,
      'wms.yard_move:' || v_task.id || ':requested',
      NULL
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'yard move event emission failed: %', SQLERRM;
  END;

  RETURN v_task;
END $$;

GRANT EXECUTE ON FUNCTION public.request_yard_move(uuid, uuid, uuid, integer, text) TO authenticated;

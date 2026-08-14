-- Phase 3 (WMS consumer audit): close the optimistic-concurrency hole on the two
-- wms_tasks mutators that lacked an expected-version parameter. Both previously
-- read the task with a plain SELECT ... INTO (no FOR UPDATE, no version check),
-- so two supervisors could split the same task concurrently and each validate
-- the requested quantity against the same stale wms_tasks.quantity.

DROP FUNCTION IF EXISTS public.wms_split_putaway_task(uuid, numeric, uuid, text);
DROP FUNCTION IF EXISTS public.wms_reassign_putaway_task(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.wms_reassign_putaway_task(
  p_task_id uuid,
  p_row_version integer,
  p_location_id uuid,
  p_reason text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_task record; v_fit jsonb; v_override boolean := false;
BEGIN
  IF p_row_version IS NULL THEN
    RAISE EXCEPTION 'wms_task_version_required: p_row_version is mandatory' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_task FROM public.wms_tasks WHERE id = p_task_id FOR UPDATE;
  IF v_task.id IS NULL THEN RAISE EXCEPTION 'task % not found', p_task_id USING ERRCODE = 'P0002'; END IF;
  IF v_task.row_version <> p_row_version THEN
    RAISE EXCEPTION 'wms_task_stale: expected v% got v%', p_row_version, v_task.row_version
      USING ERRCODE = '40001';
  END IF;
  IF NOT user_can_access_business(auth.uid(), v_task.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF v_task.task_type <> 'putaway' THEN RAISE EXCEPTION 'task is not putaway'; END IF;
  IF v_task.state IN ('completed','cancelled') THEN RAISE EXCEPTION 'task already %', v_task.state; END IF;

  PERFORM 1 FROM public.stock_locations WHERE id = p_location_id AND warehouse_id = v_task.warehouse_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'bin is not in this warehouse'; END IF;

  IF v_task.product_id IS NOT NULL THEN
    v_fit := public.wms_location_feasible(p_location_id, v_task.product_id,
               COALESCE(v_task.quantity,0), v_task.lot_number);
    IF NOT (v_fit->>'feasible')::boolean
       OR COALESCE((v_fit->>'feasible_qty')::numeric,0) < COALESCE(v_task.quantity,0) THEN
      IF p_reason IS NULL OR btrim(p_reason) = '' THEN
        RAISE EXCEPTION 'bin rejected: %', COALESCE(v_fit->>'reason','insufficient capacity');
      END IF;
      v_override := true;
    END IF;
  END IF;

  UPDATE public.wms_tasks
     SET destination_location_id = p_location_id,
         row_version = v_task.row_version + 1,
         metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object(
           'reassigned_from', v_task.destination_location_id,
           'reassign_reason', p_reason,
           'reassign_override', v_override,
           'reassigned_by', auth.uid(),
           'reassigned_at', now())
   WHERE id = p_task_id;

  UPDATE public.wms_putaway_suggestions SET chosen = (location_id = p_location_id)
   WHERE task_id = p_task_id;

  INSERT INTO public.wms_putaway_suggestions (
    organization_id, business_id, branch_id, task_id, location_id, rank, reason, chosen,
    strategy, feasible_qty, score)
  SELECT v_task.organization_id, v_task.business_id, v_task.branch_id, p_task_id, p_location_id,
         COALESCE((SELECT MAX(rank) FROM public.wms_putaway_suggestions WHERE task_id = p_task_id), 0) + 1,
         COALESCE(NULLIF(p_reason,''), 'manual reassignment'), true,
         'manual', COALESCE((v_fit->>'feasible_qty')::numeric, v_task.quantity), 0
  WHERE NOT EXISTS (
    SELECT 1 FROM public.wms_putaway_suggestions
    WHERE task_id = p_task_id AND location_id = p_location_id);

  RETURN jsonb_build_object('task_id', p_task_id, 'location_id', p_location_id,
                            'override', v_override, 'row_version', v_task.row_version + 1);
END; $function$;

CREATE OR REPLACE FUNCTION public.wms_split_putaway_task(
  p_task_id uuid,
  p_row_version integer,
  p_quantity numeric,
  p_location_id uuid DEFAULT NULL::uuid,
  p_reason text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_task record; v_dest uuid; v_fit jsonb; v_remaining numeric;
  v_new_lpn uuid; v_code text; v_child_task uuid;
BEGIN
  IF p_row_version IS NULL THEN
    RAISE EXCEPTION 'wms_task_version_required: p_row_version is mandatory' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_task FROM public.wms_tasks WHERE id = p_task_id FOR UPDATE;
  IF v_task.id IS NULL THEN RAISE EXCEPTION 'task % not found', p_task_id USING ERRCODE = 'P0002'; END IF;
  IF v_task.row_version <> p_row_version THEN
    RAISE EXCEPTION 'wms_task_stale: expected v% got v%', p_row_version, v_task.row_version
      USING ERRCODE = '40001';
  END IF;
  IF NOT user_can_access_business(auth.uid(), v_task.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF v_task.task_type <> 'putaway' THEN RAISE EXCEPTION 'task is not putaway'; END IF;
  IF v_task.state IN ('completed','cancelled') THEN RAISE EXCEPTION 'task already %', v_task.state; END IF;
  IF COALESCE(p_quantity,0) <= 0 THEN RAISE EXCEPTION 'quantity must be positive'; END IF;
  IF p_quantity >= COALESCE(v_task.quantity,0) THEN
    RAISE EXCEPTION 'use complete_putaway_task for the full quantity';
  END IF;

  v_dest := COALESCE(p_location_id, v_task.destination_location_id);
  IF v_dest IS NULL THEN RAISE EXCEPTION 'no destination bin'; END IF;
  PERFORM 1 FROM public.stock_locations WHERE id = v_dest AND warehouse_id = v_task.warehouse_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'bin is not in this warehouse'; END IF;

  v_fit := public.wms_location_feasible(v_dest, v_task.product_id, p_quantity, v_task.lot_number);
  IF NOT (v_fit->>'feasible')::boolean
     OR COALESCE((v_fit->>'feasible_qty')::numeric,0) < p_quantity THEN
    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
      RAISE EXCEPTION 'bin rejected: %', COALESCE(v_fit->>'reason','insufficient capacity');
    END IF;
  END IF;

  v_remaining := COALESCE(v_task.quantity,0) - p_quantity;

  -- Move the split portion out of the staged plate's quant.
  UPDATE public.stock_quants
     SET quantity = quantity - p_quantity
   WHERE package_id = v_task.lpn_id
     AND product_id = v_task.product_id
     AND location_id = v_task.source_location_id
     AND COALESCE(quantity,0) >= p_quantity
     AND lot_number IS NOT DISTINCT FROM v_task.lot_number;
  IF NOT FOUND THEN RAISE EXCEPTION 'staged quantity not available to split'; END IF;

  v_code := 'LPN-' || to_char(now(),'YY') || upper(substr(md5(gen_random_uuid()::text),1,6));
  INSERT INTO public.wms_license_plates (
    organization_id, business_id, branch_id, warehouse_id,
    code, lpn_type, status, current_location_id, created_by)
  VALUES (v_task.organization_id, v_task.business_id, v_task.branch_id, v_task.warehouse_id,
          v_code, 'pallet', 'open', v_dest, auth.uid())
  RETURNING id INTO v_new_lpn;

  INSERT INTO public.stock_quants (
    organization_id, business_id, branch_id,
    product_id, location_id, lot_number, package_id, quantity)
  VALUES (v_task.organization_id, v_task.business_id, v_task.branch_id,
          v_task.product_id, v_dest, v_task.lot_number, v_new_lpn, p_quantity);

  -- Audit child task recording the stored portion.
  INSERT INTO public.wms_tasks (
    organization_id, business_id, branch_id, warehouse_id,
    task_type, state, priority, source_doc_type, source_doc_id,
    source_location_id, destination_location_id,
    product_id, lot_number, lpn_id, quantity, metadata, created_by,
    started_at, completed_at, assignee_user_id)
  VALUES (v_task.organization_id, v_task.business_id, v_task.branch_id, v_task.warehouse_id,
    'putaway', 'completed', v_task.priority, v_task.source_doc_type, v_task.source_doc_id,
    v_task.source_location_id, v_dest,
    v_task.product_id, v_task.lot_number, v_new_lpn, p_quantity,
    jsonb_build_object('split_from_task_id', p_task_id, 'split_reason', p_reason,
                       'feasibility', v_fit),
    auth.uid(), now(), now(), auth.uid())
  RETURNING id INTO v_child_task;

  UPDATE public.wms_tasks
     SET quantity = v_remaining,
         state = CASE WHEN state = 'pending' THEN 'in_progress' ELSE state END,
         row_version = v_task.row_version + 1,
         metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object(
           'last_split_task_id', v_child_task,
           'last_split_quantity', p_quantity,
           'last_split_at', now())
   WHERE id = p_task_id;

  RETURN jsonb_build_object('task_id', p_task_id, 'child_task_id', v_child_task,
    'lpn_id', v_new_lpn, 'stored', p_quantity, 'remaining', v_remaining,
    'row_version', v_task.row_version + 1);
END; $function$;

GRANT EXECUTE ON FUNCTION public.wms_reassign_putaway_task(uuid, integer, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wms_split_putaway_task(uuid, integer, numeric, uuid, text) TO authenticated;
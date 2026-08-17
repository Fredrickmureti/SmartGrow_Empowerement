-- INV-SIM Repair #3: complete_replenish_task assigned an untyped text literal
-- to wms_replen_orders.state (an enum) -> 42804 on every completion, so no
-- replenishment could ever finish. Cast the CASE result to the enum.
CREATE OR REPLACE FUNCTION public.complete_replenish_task(
  p_task_id uuid,
  p_moved_qty numeric,
  p_source_scan text DEFAULT NULL::text,
  p_destination_scan text DEFAULT NULL::text,
  p_lot_number text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_task public.wms_tasks;
  v_order public.wms_replen_orders;
  v_src public.stock_locations;
  v_dst public.stock_locations;
  v_available numeric;
  v_short boolean;
  v_movement_id uuid;
BEGIN
  SELECT * INTO v_task FROM public.wms_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'task % not found', p_task_id; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_task.business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF v_task.task_type <> 'replenish' THEN RAISE EXCEPTION 'task is not a replenishment task'; END IF;
  IF v_task.state IN ('completed','cancelled') THEN
    RAISE EXCEPTION 'task already closed (%)', v_task.state;
  END IF;
  IF p_moved_qty IS NULL OR p_moved_qty <= 0 THEN RAISE EXCEPTION 'moved qty must be > 0'; END IF;
  IF v_task.source_location_id IS NULL OR v_task.destination_location_id IS NULL THEN
    RAISE EXCEPTION 'task is missing source or destination';
  END IF;

  SELECT * INTO v_src FROM public.stock_locations WHERE id = v_task.source_location_id;
  SELECT * INTO v_dst FROM public.stock_locations WHERE id = v_task.destination_location_id;

  -- Scan validation: accept location code or barcode.
  IF p_source_scan IS NOT NULL
     AND p_source_scan NOT IN (COALESCE(v_src.code,''), COALESCE(v_src.barcode,'')) THEN
    RAISE EXCEPTION 'scanned source % does not match task source %', p_source_scan, v_src.code;
  END IF;
  IF p_destination_scan IS NOT NULL
     AND p_destination_scan NOT IN (COALESCE(v_dst.code,''), COALESCE(v_dst.barcode,'')) THEN
    RAISE EXCEPTION 'scanned destination % does not match pick face %', p_destination_scan, v_dst.code;
  END IF;

  SELECT COALESCE(SUM(quantity), 0) INTO v_available
    FROM public.stock_quants
   WHERE location_id = v_task.source_location_id AND product_id = v_task.product_id;
  IF p_moved_qty > v_available THEN
    RAISE EXCEPTION 'source holds only % units', v_available;
  END IF;

  SELECT * INTO v_order FROM public.wms_replen_orders
   WHERE id = COALESCE((v_task.metadata->>'replen_order_id')::uuid, v_task.source_doc_id)
   FOR UPDATE;

  -- Release the reservation before the movement so the quant maths is clean.
  IF v_order.id IS NOT NULL THEN
    PERFORM public._wms_replen_release(v_order, LEAST(v_order.reserved_qty, p_moved_qty));
  END IF;

  INSERT INTO public.stock_movements (
    organization_id, business_id, branch_id, warehouse_id,
    product_id, movement_type, quantity, lot_number,
    source_location_id, destination_location_id,
    reference_type, reference_id, notes, created_by
  ) VALUES (
    v_task.organization_id, v_task.business_id, v_task.branch_id, v_task.warehouse_id,
    v_task.product_id, 'transfer', p_moved_qty, COALESCE(p_lot_number, v_task.lot_number),
    v_task.source_location_id, v_task.destination_location_id,
    'wms_replen_task', p_task_id,
    'Replenishment ' || COALESCE(v_src.code,'?') || ' -> ' || COALESCE(v_dst.code,'?'),
    auth.uid()
  ) RETURNING id INTO v_movement_id;

  v_short := p_moved_qty < COALESCE(v_task.quantity, p_moved_qty);

  UPDATE public.wms_tasks
     SET state = 'completed',
         quantity = p_moved_qty,
         completed_at = now(),
         started_at = COALESCE(started_at, now()),
         assignee_user_id = COALESCE(assignee_user_id, auth.uid()),
         row_version = row_version + 1
   WHERE id = p_task_id;

  IF v_order.id IS NOT NULL THEN
    -- Release any residual reservation when the move came up short.
    IF v_short THEN
      PERFORM public._wms_replen_release(v_order, GREATEST(v_order.reserved_qty - p_moved_qty, 0));
    END IF;
    UPDATE public.wms_replen_orders
       SET state = (CASE WHEN v_short THEN 'short' ELSE 'completed' END)::public.wms_replen_order_state,
           moved_qty = moved_qty + p_moved_qty,
           reserved_qty = 0,
           completed_at = now(),
           row_version = row_version + 1
     WHERE id = v_order.id;
  END IF;

  IF v_short THEN
    PERFORM public.wms_raise_exception(
      v_task.warehouse_id, 'short_pick'::public.wms_exception_kind,
      'Replenishment short: moved ' || p_moved_qty || ' of ' || v_task.quantity,
      'wms_replen_order', v_order.id, p_task_id, NULL, 2::smallint,
      jsonb_build_object('requested', v_task.quantity, 'moved', p_moved_qty)
    );
  END IF;

  RETURN jsonb_build_object(
    'task_id', p_task_id,
    'order_id', v_order.id,
    'moved_qty', p_moved_qty,
    'short', v_short,
    'movement_id', v_movement_id
  );
END; $function$;
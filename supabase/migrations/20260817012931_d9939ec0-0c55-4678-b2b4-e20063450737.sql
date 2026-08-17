-- INV-SIM Repair #5: create_count_session_as produced a zombie session when
-- the requested scope matched no quants — no lines, no physical_count_id, no
-- tasks. post_count_session then failed with "session has no linked inventory
-- count document — reopen the session", which is unrecoverable. Fail fast.
CREATE OR REPLACE FUNCTION public.create_count_session_as(
  p_actor uuid,
  p_warehouse_id uuid,
  p_strategy text DEFAULT 'targeted'::text,
  p_location_ids uuid[] DEFAULT NULL::uuid[],
  p_notes text DEFAULT NULL::text,
  p_is_blind boolean DEFAULT false,
  p_assign_to uuid DEFAULT NULL::uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_wh record;
  v_session_id uuid;
  v_code text;
  v_pc_id uuid;
  v_products uuid[];
  v_seed jsonb;
  v_tasks int := 0;
  v_lines int := 0;
BEGIN
  SELECT id, organization_id, business_id, branch_id
    INTO v_wh
    FROM public.warehouses WHERE id = p_warehouse_id;
  IF v_wh.id IS NULL THEN RAISE EXCEPTION 'warehouse % not found', p_warehouse_id; END IF;

  IF p_location_ids IS NOT NULL
     AND EXISTS (SELECT 1 FROM unnest(p_location_ids) x WHERE x IS NULL) THEN
    RAISE EXCEPTION 'WMS_COUNT_INVALID_SCOPE: location list contains a null id'
      USING ERRCODE = 'check_violation';
  END IF;

  v_code := 'CC-' || to_char(clock_timestamp(), 'YYMMDD-HH24MISSMS');

  INSERT INTO public.wms_count_sessions (
    organization_id, business_id, branch_id, warehouse_id,
    code, strategy, state, notes, created_by, is_blind
  ) VALUES (
    v_wh.organization_id, v_wh.business_id, v_wh.branch_id, p_warehouse_id,
    v_code, p_strategy::public.wms_count_strategy, 'counting', p_notes, p_actor, p_is_blind
  )
  RETURNING id INTO v_session_id;

  INSERT INTO public.wms_count_lines (
    session_id, organization_id, business_id,
    location_id, product_id, lot_number, system_qty, assigned_to
  )
  SELECT
    v_session_id, v_wh.organization_id, v_wh.business_id,
    q.location_id, q.product_id, q.lot_number, COALESCE(q.quantity, 0), p_assign_to
    FROM public.stock_quants q
    JOIN public.stock_locations sl ON sl.id = q.location_id
   WHERE sl.warehouse_id = p_warehouse_id
     AND q.business_id = v_wh.business_id
     AND (p_location_ids IS NULL OR q.location_id = ANY(p_location_ids));
  GET DIAGNOSTICS v_lines = ROW_COUNT;

  IF v_lines = 0 THEN
    RAISE EXCEPTION 'WMS_COUNT_EMPTY_SCOPE: no stock found in the selected scope — nothing to count'
      USING ERRCODE = 'no_data_found',
            HINT = 'pick locations that hold stock, or use a wider counting strategy';
  END IF;

  -- Canonical count document (Inventory owns tolerance / approval / GL).
  SELECT array_agg(DISTINCT product_id),
         jsonb_agg(jsonb_build_object('product_id', product_id, 'system_qty', sys))
    INTO v_products, v_seed
    FROM (
      SELECT product_id, SUM(system_qty) AS sys
        FROM public.wms_count_lines
       WHERE session_id = v_session_id
       GROUP BY product_id
    ) agg;

  v_pc_id := public.physical_count_create(
    v_wh.organization_id, v_wh.business_id, p_warehouse_id, p_actor,
    'cycle',
    jsonb_build_object(
      'source', 'wms_count_session',
      'session_id', v_session_id,
      'session_code', v_code,
      'strategy', p_strategy,
      'blind', p_is_blind,
      'location_ids', to_jsonb(COALESCE(p_location_ids, ARRAY[]::uuid[]))
    ),
    NULL, NULL
  );

  PERFORM public.physical_count_freeze_scoped(v_pc_id, p_actor, v_products, v_seed);

  UPDATE public.wms_count_sessions
     SET physical_count_id = v_pc_id
   WHERE id = v_session_id;

  -- One claimable count task per bin.
  INSERT INTO public.wms_tasks (
    organization_id, business_id, branch_id, warehouse_id,
    task_type, state, priority, assignee_user_id,
    source_doc_type, source_doc_id, source_location_id, notes, created_by
  )
  SELECT DISTINCT
    v_wh.organization_id, v_wh.business_id, v_wh.branch_id, p_warehouse_id,
    'count'::public.wms_task_type,
    CASE WHEN p_assign_to IS NULL THEN 'pending'::public.wms_task_state
         ELSE 'claimed'::public.wms_task_state END,
    100, p_assign_to,
    'wms_count_session', v_session_id, l.location_id,
    'Cycle count ' || v_code, p_actor
    FROM public.wms_count_lines l
   WHERE l.session_id = v_session_id;
  GET DIAGNOSTICS v_tasks = ROW_COUNT;

  RETURN v_session_id;
END;
$function$;
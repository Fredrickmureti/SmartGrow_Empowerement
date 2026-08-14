-- Phase 5 follow-up: the Phase 5 rewrite left the retired topic names inside
-- explanatory comments, which trips the "no retired vocabulary is emitted"
-- ratchet. Reword; bodies are otherwise byte-identical.
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
BEGIN
  SELECT id, organization_id, business_id, branch_id
    INTO v_wh
    FROM public.warehouses WHERE id = p_warehouse_id;
  IF v_wh.id IS NULL THEN RAISE EXCEPTION 'warehouse % not found', p_warehouse_id; END IF;

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

  IF v_products IS NOT NULL THEN
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
  END IF;

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

  -- NOTE (ADR 0101 / Phase 5): no in-body outbox emit here. The
  -- `trg_wms_counts_emit` AFTER INSERT trigger is the single producer of the
  -- session lifecycle event (canonical key `wms.count:<id>:counting`); the
  -- former in-body emit used a retired topic name that no catalog row and no
  -- consumer recognised.

  RETURN v_session_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.post_count_session(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_session record;
  v_row record;
  v_variance_count int := 0;
  v_unexplained int := 0;
  v_open_recounts int := 0;
  v_submit jsonb;
BEGIN
  SELECT * INTO v_session FROM public.wms_count_sessions WHERE id = p_session_id FOR UPDATE;
  IF v_session.id IS NULL THEN RAISE EXCEPTION 'session % not found', p_session_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_session.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF v_session.state IN ('posted','cancelled') THEN
    RAISE EXCEPTION 'session in state % cannot be submitted', v_session.state;
  END IF;
  IF v_session.physical_count_id IS NULL THEN
    RAISE EXCEPTION 'session % has no linked inventory count document — reopen the session',
      p_session_id USING ERRCODE='P0001';
  END IF;

  SELECT count(*) INTO v_unexplained
    FROM public.wms_count_lines l
   WHERE l.session_id = p_session_id
     AND l.counted_qty IS NOT NULL
     AND COALESCE(l.variance_qty, 0) <> 0
     AND l.variance_reason IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.wms_count_lines r WHERE r.recount_of_line_id = l.id);

  IF v_unexplained > 0 THEN
    RAISE EXCEPTION 'cannot submit: % variance line(s) have no reason code', v_unexplained
      USING ERRCODE='P0001', HINT='classify every variance before submitting the session';
  END IF;

  SELECT count(*) INTO v_open_recounts
    FROM public.wms_count_lines l
   WHERE l.session_id = p_session_id
     AND l.tolerance_outcome = 'recount_required'
     AND NOT EXISTS (SELECT 1 FROM public.wms_count_lines r WHERE r.recount_of_line_id = l.id);

  IF v_open_recounts > 0 THEN
    RAISE EXCEPTION 'cannot submit: % line(s) still require a recount', v_open_recounts
      USING ERRCODE='P0001';
  END IF;

  FOR v_row IN
    SELECT l.product_id,
           SUM(COALESCE(l.counted_qty, l.system_qty)) AS counted,
           SUM(l.system_qty)                          AS system_qty
      FROM public.wms_count_lines l
     WHERE l.session_id = p_session_id
       AND NOT EXISTS (SELECT 1 FROM public.wms_count_lines r WHERE r.recount_of_line_id = l.id)
     GROUP BY l.product_id
  LOOP
    PERFORM public.physical_count_record_line(
      v_session.physical_count_id, v_row.product_id, v_row.counted, auth.uid(),
      NULL, 'wms_count_session:' || p_session_id::text
    );
    IF v_row.counted <> v_row.system_qty THEN
      v_variance_count := v_variance_count + 1;
    END IF;
  END LOOP;

  v_submit := public.physical_count_submit(v_session.physical_count_id, auth.uid());

  UPDATE public.wms_count_sessions
     SET state = 'review'
   WHERE id = p_session_id
     AND state <> 'review';

  -- NOTE (ADR 0101 / Phase 5): emission belongs to `trg_wms_counts_emit`
  -- (canonical key `wms.count:<id>:review`). The former in-body emit used a
  -- retired topic name and duplicated the trigger.

  RETURN jsonb_build_object(
    'session_id', p_session_id,
    'physical_count_id', v_session.physical_count_id,
    'variance_count', v_variance_count,
    'submit_result', v_submit,
    'handoff', 'inventory_physical_count'
  );
END;
$function$;

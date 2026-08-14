-- Phase 5 — event-driven integration hygiene (ADR 0101).

-- 1. create_count_session_as: drop the duplicate, off-vocabulary
--    'warehouse.count.opened' in-body emit. trg_wms_counts_emit already
--    publishes 'warehouse.count.counting' on INSERT (single producer rule).
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
  -- `trg_wms_counts_emit` AFTER INSERT trigger publishes
  -- 'warehouse.count.counting' with the canonical idempotency key
  -- `wms.count:<id>:counting`. The former in-body
  -- 'warehouse.count.opened' emit was a retired-vocabulary duplicate that
  -- no consumer and no catalog row recognised.

  RETURN v_session_id;
END;
$function$;

-- 2. post_count_session: same — trg_wms_counts_emit publishes
--    'warehouse.count.review' on the state change to `review`.
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

  -- Superseded attempts are excluded: only the newest attempt per line chain counts.
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
  -- ('warehouse.count.review', key `wms.count:<id>:review`). The former
  -- in-body 'warehouse.count.submitted' emit was an unregistered duplicate.

  RETURN jsonb_build_object(
    'session_id', p_session_id,
    'physical_count_id', v_session.physical_count_id,
    'variance_count', v_variance_count,
    'submit_result', v_submit,
    'handoff', 'inventory_physical_count'
  );
END;
$function$;

-- 3. Event-triggered cycle counts: the consumer keyed off two topics that
--    no producer emits anymore, so replenishment- and return-driven counts
--    never fired. Route the live topic names.
CREATE OR REPLACE FUNCTION public._wms_count_trigger_from_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_event text; v_loc uuid;
BEGIN
  v_event := CASE NEW.event_type
    WHEN 'warehouse.count.posted'                THEN 'variance'
    WHEN 'warehouse.replen.completed'            THEN 'replenishment'
    WHEN 'warehouse.return.dispositions_posted'  THEN 'return'
    WHEN 'warehouse.receipt.staged'              THEN 'receipt'
    ELSE NULL END;
  IF v_event IS NULL OR NEW.warehouse_id IS NULL THEN RETURN NEW; END IF;

  v_loc := NULLIF(NEW.payload->>'location_id', '')::uuid;
  IF v_loc IS NULL THEN RETURN NEW; END IF;

  BEGIN
    PERFORM public.wms_evaluate_count_trigger(
      NEW.warehouse_id, v_loc, v_event, NEW.actor_user_id
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'count trigger evaluation failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$function$;

-- 4. Labour plan emits: use the canonical ADR 0101 key shape
--    `wms.{aggregate}:{id}:{transition}`.
CREATE OR REPLACE FUNCTION public.wms_publish_labour_plan(
  _warehouse_id uuid,
  _from date,
  _to date,
  _gap_threshold_hours numeric DEFAULT 4
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  w public.warehouses;
  v_published integer := 0;
  v_gaps jsonb := '[]'::jsonb;
  r record;
BEGIN
  SELECT * INTO w FROM public.warehouses WHERE id = _warehouse_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse not found' USING ERRCODE = '22023';
  END IF;

  IF NOT public.user_has_module_permission(auth.uid(), w.business_id, 'inventory', 'write') THEN
    RAISE EXCEPTION 'not authorised to publish a labour plan' USING ERRCODE = '42501';
  END IF;

  UPDATE public.wms_operator_shifts
     SET status = 'published', updated_at = now()
   WHERE warehouse_id = _warehouse_id
     AND shift_date BETWEEN _from AND _to
     AND status = 'planned';
  GET DIAGNOSTICS v_published = ROW_COUNT;

  FOR r IN
    SELECT * FROM public.wms_labour_plan(_warehouse_id, _from, _to) pl
     WHERE pl.gap_seconds > _gap_threshold_hours * 3600
  LOOP
    v_gaps := v_gaps || jsonb_build_object(
      'date', r.plan_date,
      'required_hours', round((r.required_seconds / 3600.0)::numeric, 2),
      'planned_hours',  round((r.planned_seconds / 3600.0)::numeric, 2),
      'gap_hours',      round((r.gap_seconds / 3600.0)::numeric, 2),
      'open_tasks',     r.open_tasks,
      'overdue_tasks',  r.overdue_tasks
    );

    PERFORM public._wms_emit_event(
      'warehouse.labour.gap_detected',
      _warehouse_id,
      w.organization_id,
      w.business_id,
      _warehouse_id,
      w.branch_id,
      auth.uid(),
      jsonb_build_object(
        'plan_date',        r.plan_date,
        'required_seconds', r.required_seconds,
        'planned_seconds',  r.planned_seconds,
        'gap_seconds',      r.gap_seconds,
        'open_tasks',       r.open_tasks,
        'overdue_tasks',    r.overdue_tasks,
        'threshold_hours',  _gap_threshold_hours
      ),
      'wms.labour:' || _warehouse_id::text || ':gap_detected:' || r.plan_date::text,
      'labour_plan',
      _warehouse_id
    );
  END LOOP;

  PERFORM public._wms_emit_event(
    'warehouse.labour.plan_published',
    _warehouse_id,
    w.organization_id,
    w.business_id,
    _warehouse_id,
    w.branch_id,
    auth.uid(),
    jsonb_build_object(
      'from', _from, 'to', _to,
      'shifts_published', v_published,
      'gap_days', jsonb_array_length(v_gaps)
    ),
    'wms.labour:' || _warehouse_id::text || ':plan_published:' || _from::text || ':' || _to::text,
    'labour_plan',
    _warehouse_id
  );

  RETURN jsonb_build_object('shifts_published', v_published, 'gaps', v_gaps);
END;
$function$;

-- 5. Register every actively emitted warehouse topic that had no catalog row.
INSERT INTO public.wms_events_catalog
  (topic, aggregate, transition, producers, consumers, description, idempotency_key_shape)
VALUES
  ('warehouse.appointment.rescheduled', 'appointment', 'rescheduled',
   ARRAY['reschedule_dock_appointment'], ARRAY['dock schedule board'],
   'A booked dock appointment moved to a new slot.', 'wms.appointment:{id}:rescheduled'),
  ('warehouse.exception.acknowledged', 'exception', 'acknowledged',
   ARRAY['wms_acknowledge_exception'], ARRAY['exception inbox'],
   'A supervisor acknowledged an open warehouse exception.', 'wms.exception:{id}:acknowledged'),
  ('warehouse.exception.assigned', 'exception', 'assigned',
   ARRAY['wms_assign_exception'], ARRAY['exception inbox'],
   'An exception was assigned to an owner.', 'wms.exception:{id}:assigned'),
  ('warehouse.exception.escalated', 'exception', 'escalated',
   ARRAY['wms_escalate_overdue_exceptions'], ARRAY['exception inbox', 'notifications'],
   'An exception breached its SLA and was escalated.', 'wms.exception:{id}:escalated'),
  ('warehouse.manifest.proof_captured', 'manifest', 'proof_captured',
   ARRAY['wms_capture_dispatch_proof'], ARRAY['dispatch board', 'shipping'],
   'Proof of dispatch (signature/photo) captured for a manifest.', 'wms.manifest:{id}:proof_captured'),
  ('warehouse.manifest.tracking_allocated', 'manifest', 'tracking_allocated',
   ARRAY['wms_allocate_tracking_number'], ARRAY['dispatch board', 'shipping'],
   'A carrier tracking number was allocated to a manifest.', 'wms.manifest:{id}:tracking_allocated'),
  ('warehouse.packaging.created', 'packaging', 'created',
   ARRAY['wms_packaging_upsert'], ARRAY['packaging master data'],
   'A warehouse packaging material record was created.', 'wms.packaging:{id}:created'),
  ('warehouse.packaging.updated', 'packaging', 'updated',
   ARRAY['wms_packaging_upsert'], ARRAY['packaging master data'],
   'A warehouse packaging material record was updated.', 'wms.packaging:{id}:updated'),
  ('warehouse.packaging.archived', 'packaging', 'archived',
   ARRAY['wms_packaging_archive'], ARRAY['packaging master data'],
   'A packaging material was archived.', 'wms.packaging:{id}:archived'),
  ('warehouse.packaging.lifecycle_changed', 'packaging', 'lifecycle_changed',
   ARRAY['wms_packaging_set_lifecycle'], ARRAY['packaging master data'],
   'A packaging material moved to another lifecycle stage.', 'wms.packaging:{id}:lifecycle_changed'),
  ('warehouse.packaging.consumed', 'packaging', 'consumed',
   ARRAY['wms_packaging_consume'], ARRAY['packaging master data', '3PL billing'],
   'Packaging material was consumed at a pack station.', 'wms.packaging:{id}:consumed'),
  ('warehouse.packaging.reorder_needed', 'packaging', 'reorder_needed',
   ARRAY['wms_packaging_consume'], ARRAY['packaging master data', 'purchasing'],
   'Packaging stock fell to or below its reorder point.', 'wms.packaging:{id}:reorder_needed'),
  ('warehouse.wave.planned', 'wave', 'planned',
   ARRAY['wms_plan_waves'], ARRAY['wave planner'],
   'A pick wave was planned from open demand.', 'wms.wave:{id}:planned')
ON CONFLICT (topic) DO NOTHING;

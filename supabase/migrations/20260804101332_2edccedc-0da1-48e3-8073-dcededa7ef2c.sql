-- ── Phase 3 cleanup: drop retired edges from the task FSM ──
CREATE OR REPLACE FUNCTION public.wms_transition_task(_task_id uuid, _to_state wms_task_state, _expected_version integer, _actor uuid DEFAULT auth.uid(), _reason text DEFAULT NULL::text, _payload_patch jsonb DEFAULT '{}'::jsonb)
RETURNS wms_tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  t public.wms_tasks;
  ok BOOLEAN;
BEGIN
  SELECT * INTO t FROM public.wms_tasks WHERE id = _task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wms_task_not_found: %', _task_id USING ERRCODE = 'P0002'; END IF;
  IF t.row_version <> _expected_version THEN
    RAISE EXCEPTION 'wms_task_stale: expected v% got v%', _expected_version, t.row_version USING ERRCODE = '40001';
  END IF;

  ok := CASE t.state::text || '>' || _to_state::text
    WHEN 'pending>available'      THEN TRUE
    WHEN 'pending>claimed'        THEN TRUE
    WHEN 'pending>cancelled'      THEN TRUE
    WHEN 'available>claimed'      THEN TRUE
    WHEN 'available>cancelled'    THEN TRUE
    WHEN 'available>pending'      THEN TRUE
    WHEN 'claimed>in_progress'    THEN TRUE
    WHEN 'claimed>available'      THEN TRUE
    WHEN 'claimed>exception'      THEN TRUE
    WHEN 'in_progress>completed'  THEN TRUE
    WHEN 'in_progress>exception'  THEN TRUE
    WHEN 'in_progress>available'  THEN TRUE
    WHEN 'in_progress>paused'     THEN TRUE
    WHEN 'paused>resumed'         THEN TRUE
    WHEN 'paused>cancelled'       THEN TRUE
    WHEN 'resumed>in_progress'    THEN TRUE
    WHEN 'exception>available'    THEN TRUE
    WHEN 'exception>cancelled'    THEN TRUE
    ELSE FALSE
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'wms_task_bad_edge: % -> %', t.state, _to_state USING ERRCODE = '22023';
  END IF;

  UPDATE public.wms_tasks SET
    state = _to_state,
    row_version = t.row_version + 1,
    started_at    = CASE WHEN _to_state IN ('in_progress','claimed') AND started_at IS NULL THEN now() ELSE started_at END,
    completed_at  = CASE WHEN _to_state = 'completed' THEN now() ELSE completed_at END,
    cancel_reason = CASE WHEN _to_state = 'cancelled' THEN COALESCE(_reason, cancel_reason) ELSE cancel_reason END,
    payload = payload || COALESCE(_payload_patch,'{}'::jsonb),
    updated_at = now()
  WHERE id = _task_id
  RETURNING * INTO t;

  RETURN t;
END $function$;

-- ── System driver: walk a task to a terminal state through legal edges only ──
CREATE OR REPLACE FUNCTION public._wms_drive_task_to(p_task_id uuid, p_target wms_task_state, p_reason text DEFAULT NULL)
RETURNS wms_task_state
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_state wms_task_state;
  v_rv integer;
  v_next wms_task_state;
  i integer := 0;
BEGIN
  IF p_target NOT IN ('completed','cancelled') THEN
    RAISE EXCEPTION 'unsupported drive target %', p_target USING ERRCODE = '22023';
  END IF;

  LOOP
    i := i + 1;
    EXIT WHEN i > 8;
    SELECT state, row_version INTO v_state, v_rv FROM public.wms_tasks WHERE id = p_task_id FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    EXIT WHEN v_state = p_target OR v_state IN ('completed','cancelled');

    IF p_target = 'cancelled' THEN
      v_next := CASE v_state
        WHEN 'pending'     THEN 'cancelled'
        WHEN 'available'   THEN 'cancelled'
        WHEN 'paused'      THEN 'cancelled'
        WHEN 'exception'   THEN 'cancelled'
        WHEN 'claimed'     THEN 'exception'
        WHEN 'in_progress' THEN 'exception'
        WHEN 'resumed'     THEN 'in_progress'
        ELSE NULL END::wms_task_state;
    ELSE
      v_next := CASE v_state
        WHEN 'pending'     THEN 'claimed'
        WHEN 'available'   THEN 'claimed'
        WHEN 'claimed'     THEN 'in_progress'
        WHEN 'in_progress' THEN 'completed'
        WHEN 'paused'      THEN 'resumed'
        WHEN 'resumed'     THEN 'in_progress'
        WHEN 'exception'   THEN 'available'
        ELSE NULL END::wms_task_state;
    END IF;

    EXIT WHEN v_next IS NULL;
    PERFORM public.wms_transition_task(p_task_id, v_next, v_rv, auth.uid(), p_reason);
  END LOOP;

  SELECT state INTO v_state FROM public.wms_tasks WHERE id = p_task_id;
  RETURN v_state;
END $function$;

CREATE OR REPLACE FUNCTION public._wms_finalize_source_tasks(
  p_source_type text, p_source_id uuid, p_task_type wms_task_type,
  p_target wms_task_state, p_reason text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN
    SELECT id FROM public.wms_tasks
     WHERE source_doc_type = p_source_type
       AND source_doc_id = p_source_id
       AND (p_task_type IS NULL OR task_type = p_task_type)
       AND state NOT IN ('completed','cancelled')
  LOOP
    PERFORM public._wms_drive_task_to(r.id, p_target, p_reason);
    n := n + 1;
  END LOOP;
  RETURN n;
END $function$;

-- ── Phase 6a: pack work generation ──
CREATE OR REPLACE FUNCTION public._wms_pack_tasks_on_wave_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE r record;
BEGIN
  IF NEW.state = OLD.state THEN RETURN NULL; END IF;

  IF NEW.state = 'picked' THEN
    FOR r IN
      SELECT sales_order_id,
             SUM(COALESCE(quantity_picked, 0)) AS qty
        FROM public.wms_pick_wave_lines
       WHERE wave_id = NEW.id
       GROUP BY sales_order_id
      HAVING SUM(COALESCE(quantity_picked, 0)) > 0
    LOOP
      IF EXISTS (
        SELECT 1 FROM public.wms_tasks
         WHERE task_type = 'pack'
           AND source_doc_type = 'wms_pick_wave'
           AND source_doc_id = NEW.id
           AND metadata->>'sales_order_id' IS NOT DISTINCT FROM r.sales_order_id::text
           AND state NOT IN ('completed','cancelled')
      ) THEN CONTINUE; END IF;

      INSERT INTO public.wms_tasks (
        organization_id, business_id, branch_id, warehouse_id,
        task_type, state, priority,
        source_doc_type, source_doc_id, quantity,
        metadata, payload, created_by
      ) VALUES (
        NEW.organization_id, NEW.business_id, NEW.branch_id, NEW.warehouse_id,
        'pack', 'pending', 60,
        'wms_pick_wave', NEW.id, r.qty,
        jsonb_build_object('wave_id', NEW.id, 'wave_number', NEW.wave_number,
                           'sales_order_id', r.sales_order_id),
        jsonb_build_object('reason', 'wave_picked'),
        auth.uid()
      );
    END LOOP;

  ELSIF NEW.state = 'packed' THEN
    PERFORM public._wms_finalize_source_tasks('wms_pick_wave', NEW.id, 'pack'::wms_task_type,
                                              'completed'::wms_task_state, 'wave packed');
  END IF;

  RETURN NULL;
END $function$;

DROP TRIGGER IF EXISTS trg_wms_pack_tasks_on_wave_state ON public.wms_pick_waves;
CREATE TRIGGER trg_wms_pack_tasks_on_wave_state
AFTER UPDATE OF state ON public.wms_pick_waves
FOR EACH ROW EXECUTE FUNCTION public._wms_pack_tasks_on_wave_state();

-- ── Phase 6b: loading work generation ──
CREATE OR REPLACE FUNCTION public._wms_load_tasks_on_manifest_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.state = OLD.state THEN RETURN NULL; END IF;

  IF NEW.state = 'loading' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.wms_tasks
       WHERE task_type = 'load'
         AND source_doc_type = 'wms_loading_manifest'
         AND source_doc_id = NEW.id
         AND state NOT IN ('completed','cancelled')
    ) THEN
      INSERT INTO public.wms_tasks (
        organization_id, business_id, branch_id, warehouse_id,
        task_type, state, priority,
        source_doc_type, source_doc_id, sla_at,
        metadata, payload, created_by
      ) VALUES (
        NEW.organization_id, NEW.business_id, NEW.branch_id, NEW.warehouse_id,
        'load', 'pending', 70,
        'wms_loading_manifest', NEW.id, NEW.planned_departure_at,
        jsonb_build_object('manifest_id', NEW.id, 'manifest_code', NEW.code,
                           'dock_id', NEW.dock_id, 'carrier_id', NEW.carrier_id),
        jsonb_build_object('reason', 'manifest_loading'),
        auth.uid()
      );
    END IF;

  ELSIF NEW.state IN ('closed','dispatched') THEN
    PERFORM public._wms_finalize_source_tasks('wms_loading_manifest', NEW.id, 'load'::wms_task_type,
                                              'completed'::wms_task_state, 'manifest ' || NEW.state::text);
  ELSIF NEW.state = 'cancelled' THEN
    PERFORM public._wms_finalize_source_tasks('wms_loading_manifest', NEW.id, 'load'::wms_task_type,
                                              'cancelled'::wms_task_state, 'manifest cancelled');
  END IF;

  RETURN NULL;
END $function$;

DROP TRIGGER IF EXISTS trg_wms_load_tasks_on_manifest_state ON public.wms_loading_manifests;
CREATE TRIGGER trg_wms_load_tasks_on_manifest_state
AFTER UPDATE OF state ON public.wms_loading_manifests
FOR EACH ROW EXECUTE FUNCTION public._wms_load_tasks_on_manifest_state();

-- ── Wave cancel must unwind every task type, not only picks ──
CREATE OR REPLACE FUNCTION public._wms_unwind_cancelled_wave(p_wave_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_wave public.wms_pick_waves;
  v_line record;
  v_open numeric;
  v_cancelled int := 0;
  v_released int := 0;
  v_restored numeric := 0;
BEGIN
  SELECT * INTO v_wave FROM public.wms_pick_waves WHERE id = p_wave_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('unwound', false); END IF;

  v_cancelled := public._wms_finalize_source_tasks(
    'wms_pick_wave', p_wave_id, NULL, 'cancelled'::wms_task_state,
    COALESCE(p_reason, 'wave cancelled'));

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

-- ── Phase 7: execution telemetry derived from the ledger ──
CREATE OR REPLACE FUNCTION public.wms_task_telemetry(
  p_warehouse_id uuid,
  p_from timestamptz DEFAULT (now() - interval '7 days'),
  p_to   timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_business uuid;
  v_by_type jsonb;
  v_by_operator jsonb;
  v_totals jsonb;
BEGIN
  SELECT business_id INTO v_business FROM public.warehouses WHERE id = p_warehouse_id;
  IF v_business IS NULL THEN RAISE EXCEPTION 'warehouse not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public._wms_assert_business_access(v_business);

  WITH ev AS (
    SELECT * FROM public.wms_task_events
     WHERE warehouse_id = p_warehouse_id
       AND created_at >= p_from AND created_at < p_to
  ),
  spans AS (
    SELECT task_id, task_type,
           MIN(created_at) FILTER (WHERE to_state = 'claimed')      AS claimed_at,
           MIN(created_at) FILTER (WHERE to_state = 'in_progress')  AS started_at,
           MAX(created_at) FILTER (WHERE to_state = 'completed')    AS completed_at,
           MIN(created_at)                                          AS first_seen,
           MAX(actor_id) FILTER (WHERE to_state = 'completed')      AS completed_by,
           COUNT(*) FILTER (WHERE to_state = 'exception')           AS exceptions,
           COUNT(*) FILTER (WHERE event_type = 'lease_reaped'
                              OR reason ILIKE '%reap%')             AS reaps,
           COUNT(*) FILTER (WHERE to_state = 'cancelled')           AS cancels
      FROM ev GROUP BY task_id, task_type
  )
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'task_type', task_type,
      'tasks', tasks,
      'completed', completed,
      'exception_rate', exception_rate,
      'reap_rate', reap_rate,
      'avg_wait_seconds', avg_wait,
      'avg_execution_seconds', avg_exec
    ) ORDER BY task_type), '[]'::jsonb)
  INTO v_by_type
  FROM (
    SELECT task_type::text AS task_type,
           COUNT(*)                                              AS tasks,
           COUNT(*) FILTER (WHERE completed_at IS NOT NULL)       AS completed,
           ROUND(AVG(CASE WHEN exceptions > 0 THEN 1 ELSE 0 END)::numeric, 4) AS exception_rate,
           ROUND(AVG(CASE WHEN reaps > 0 THEN 1 ELSE 0 END)::numeric, 4)      AS reap_rate,
           ROUND(AVG(EXTRACT(epoch FROM (COALESCE(claimed_at, started_at) - first_seen)))::numeric, 1) AS avg_wait,
           ROUND(AVG(EXTRACT(epoch FROM (completed_at - COALESCE(started_at, claimed_at))))::numeric, 1) AS avg_exec
      FROM spans GROUP BY task_type
  ) s;

  WITH ev AS (
    SELECT * FROM public.wms_task_events
     WHERE warehouse_id = p_warehouse_id
       AND created_at >= p_from AND created_at < p_to
  ),
  spans AS (
    SELECT task_id, task_type,
           MIN(created_at) FILTER (WHERE to_state = 'in_progress') AS started_at,
           MIN(created_at) FILTER (WHERE to_state = 'claimed')     AS claimed_at,
           MAX(created_at) FILTER (WHERE to_state = 'completed')   AS completed_at,
           MAX(actor_id)   FILTER (WHERE to_state = 'completed')   AS completed_by,
           COUNT(*) FILTER (WHERE to_state = 'exception')          AS exceptions
      FROM ev GROUP BY task_id, task_type
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'operator_id', operator_id,
           'completed', completed,
           'avg_execution_seconds', avg_exec,
           'exceptions', exceptions
         ) ORDER BY completed DESC), '[]'::jsonb)
  INTO v_by_operator
  FROM (
    SELECT completed_by AS operator_id,
           COUNT(*) FILTER (WHERE completed_at IS NOT NULL) AS completed,
           ROUND(AVG(EXTRACT(epoch FROM (completed_at - COALESCE(started_at, claimed_at))))::numeric, 1) AS avg_exec,
           SUM(exceptions) AS exceptions
      FROM spans
     WHERE completed_by IS NOT NULL
     GROUP BY completed_by
     LIMIT 25
  ) o;

  SELECT jsonb_build_object(
    'events', COUNT(*),
    'tasks_touched', COUNT(DISTINCT task_id),
    'completed', COUNT(*) FILTER (WHERE to_state = 'completed'),
    'cancelled', COUNT(*) FILTER (WHERE to_state = 'cancelled'),
    'exceptions', COUNT(*) FILTER (WHERE to_state = 'exception'),
    'active_operators', COUNT(DISTINCT actor_id) FILTER (WHERE actor_id IS NOT NULL)
  ) INTO v_totals
  FROM public.wms_task_events
   WHERE warehouse_id = p_warehouse_id
     AND created_at >= p_from AND created_at < p_to;

  RETURN jsonb_build_object(
    'warehouse_id', p_warehouse_id,
    'from', p_from, 'to', p_to,
    'totals', v_totals,
    'by_type', v_by_type,
    'by_operator', v_by_operator
  );
END $function$;

GRANT EXECUTE ON FUNCTION public.wms_task_telemetry(uuid, timestamptz, timestamptz) TO authenticated;
REVOKE ALL ON FUNCTION public._wms_drive_task_to(uuid, wms_task_state, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._wms_finalize_source_tasks(text, uuid, wms_task_type, wms_task_state, text) FROM PUBLIC;
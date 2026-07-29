-- ============================================================
-- WMS event emission: single producer (triggers), legacy in-body
-- emitters removed. Fixes the from_status/from_state defect by
-- construction (OLD is only visible to the trigger).
-- ============================================================

-- 1. Dedicated LPN status emitter (replaces the generic one so the
--    plate code + location context survives the removal of the
--    in-body emitter in wms_transition_lpn).
CREATE OR REPLACE FUNCTION public._wms_emit_lpn_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_allowed text[] := ARRAY['receiving','putaway','stored','picked','packed',
                            'sealed','staged','loaded','shipped','quarantined','voided'];
  v_prev text := CASE WHEN TG_OP = 'UPDATE' THEN OLD.status::text ELSE NULL END;
BEGIN
  IF NEW.status IS NULL OR NOT (NEW.status::text = ANY (v_allowed)) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND v_prev IS NOT DISTINCT FROM NEW.status::text THEN
    RETURN NULL;
  END IF;

  PERFORM public._wms_emit_event(
    'warehouse.lpn.' || NEW.status::text,
    NEW.id, NEW.organization_id, NEW.business_id, NEW.warehouse_id, NEW.branch_id,
    auth.uid(),
    jsonb_build_object(
      'code',             NEW.code,
      'from_status',      v_prev,
      'to_status',        NEW.status::text,
      'from_location_id', CASE WHEN TG_OP = 'UPDATE' THEN OLD.current_location_id ELSE NULL END,
      'to_location_id',   NEW.current_location_id,
      'emitted_by',       'trigger:wms_license_plates'
    ),
    'wms.lpn:' || NEW.id::text || ':' || NEW.status::text
  );
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_wms_lpn_emit ON public.wms_license_plates;
CREATE TRIGGER trg_wms_lpn_emit
AFTER INSERT OR UPDATE OF status ON public.wms_license_plates
FOR EACH ROW EXECUTE FUNCTION public._wms_emit_lpn_event();

-- 2. Task emitter picks up the fields the in-body emitter carried
--    (cancel reason + source document linkage).
CREATE OR REPLACE FUNCTION public._wms_emit_task_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_transition text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NULL;
  END IF;

  v_transition := CASE NEW.state::text
    WHEN 'done'        THEN 'completed'
    WHEN 'completed'   THEN 'completed'
    WHEN 'available'   THEN 'available'
    WHEN 'assigned'    THEN 'assigned'
    WHEN 'claimed'     THEN 'claimed'
    WHEN 'in_progress' THEN 'in_progress'
    WHEN 'exception'   THEN 'exception'
    WHEN 'cancelled'   THEN 'cancelled'
    ELSE NULL
  END;
  IF v_transition IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM public._wms_emit_event(
    'warehouse.task.' || v_transition,
    NEW.id, NEW.organization_id, NEW.business_id, NEW.warehouse_id, NEW.branch_id,
    COALESCE(auth.uid(), NEW.assignee_user_id),
    jsonb_build_object(
      'task_type',               NEW.task_type,
      'state',                   NEW.state,
      'from_state',              CASE WHEN TG_OP = 'UPDATE' THEN OLD.state::text ELSE NULL END,
      'priority',                NEW.priority,
      'assignee_user_id',        NEW.assignee_user_id,
      'source_location_id',      NEW.source_location_id,
      'destination_location_id', NEW.destination_location_id,
      'product_id',              NEW.product_id,
      'lot_number',              NEW.lot_number,
      'lpn_id',                  NEW.lpn_id,
      'quantity',                NEW.quantity,
      'started_at',              NEW.started_at,
      'completed_at',            NEW.completed_at,
      'cancel_reason',           NEW.cancel_reason,
      'emitted_by',              'trigger:wms_tasks'
    ),
    'wms.task:' || NEW.id::text || ':' || v_transition,
    COALESCE(NEW.source_doc_type, 'wms_task'),
    COALESCE(NEW.source_doc_id, NEW.id)
  );
  RETURN NULL;
END;
$function$;

-- 3. Legacy in-body emitters removed. The triggers above are now the
--    only producer for these aggregates.
CREATE OR REPLACE FUNCTION public.wms_transition_lpn(_lpn_id uuid, _to_status wms_lpn_status, _expected_version integer, _to_location uuid DEFAULT NULL::uuid, _actor uuid DEFAULT auth.uid(), _reason text DEFAULT NULL::text)
RETURNS wms_license_plates
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  l public.wms_license_plates;
  ok BOOLEAN;
BEGIN
  SELECT * INTO l FROM public.wms_license_plates WHERE id = _lpn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wms_lpn_not_found: %', _lpn_id USING ERRCODE = 'P0002'; END IF;
  IF l.row_version <> _expected_version THEN
    RAISE EXCEPTION 'wms_lpn_stale' USING ERRCODE = '40001';
  END IF;

  ok := CASE l.status::text || '>' || _to_status::text
    WHEN 'draft>receiving'       THEN TRUE
    WHEN 'open>receiving'        THEN TRUE
    WHEN 'receiving>putaway'     THEN TRUE
    WHEN 'putaway>stored'        THEN TRUE
    WHEN 'stored>picked'         THEN TRUE
    WHEN 'picked>packed'         THEN TRUE
    WHEN 'packed>sealed'         THEN TRUE
    WHEN 'packed>staged'         THEN TRUE
    WHEN 'sealed>staged'         THEN TRUE
    WHEN 'staged>loaded'         THEN TRUE
    WHEN 'loaded>shipped'        THEN TRUE
    WHEN 'stored>quarantined'    THEN TRUE
    WHEN 'receiving>quarantined' THEN TRUE
    WHEN 'quarantined>stored'    THEN TRUE
    WHEN 'quarantined>voided'    THEN TRUE
    WHEN 'stored>consumed'       THEN TRUE
    WHEN 'draft>voided'          THEN TRUE
    WHEN 'stored>voided'         THEN TRUE
    WHEN 'shipped>retired'       THEN TRUE
    WHEN 'shipped>voided'        THEN TRUE
    ELSE FALSE
  END;
  IF NOT ok THEN RAISE EXCEPTION 'wms_lpn_bad_edge: % -> %', l.status, _to_status USING ERRCODE = '22023'; END IF;

  -- Event emission is owned by trg_wms_lpn_emit / trg_wms_lpn_moved.
  UPDATE public.wms_license_plates SET
    status = _to_status,
    current_location_id = COALESCE(_to_location, current_location_id),
    row_version = l.row_version + 1,
    updated_at = now()
  WHERE id = _lpn_id
  RETURNING * INTO l;

  RETURN l;
END $function$;

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
    WHEN 'pending>available'     THEN TRUE
    WHEN 'pending>claimed'       THEN TRUE
    WHEN 'available>claimed'     THEN TRUE
    WHEN 'available>cancelled'   THEN TRUE
    WHEN 'assigned>claimed'      THEN TRUE
    WHEN 'assigned>in_progress'  THEN TRUE
    WHEN 'claimed>in_progress'   THEN TRUE
    WHEN 'claimed>available'     THEN TRUE
    WHEN 'claimed>exception'     THEN TRUE
    WHEN 'in_progress>completed' THEN TRUE
    WHEN 'in_progress>done'      THEN TRUE
    WHEN 'in_progress>exception' THEN TRUE
    WHEN 'in_progress>available' THEN TRUE
    WHEN 'exception>available'   THEN TRUE
    WHEN 'exception>cancelled'   THEN TRUE
    WHEN 'pending>cancelled'     THEN TRUE
    WHEN 'available>pending'     THEN TRUE
    ELSE FALSE
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'wms_task_bad_edge: % -> %', t.state, _to_state USING ERRCODE = '22023';
  END IF;

  -- Event emission is owned by trg_wms_tasks_emit.
  UPDATE public.wms_tasks SET
    state = _to_state,
    row_version = t.row_version + 1,
    started_at   = CASE WHEN _to_state IN ('in_progress','claimed') AND started_at IS NULL THEN now() ELSE started_at END,
    completed_at = CASE WHEN _to_state IN ('completed','done') THEN now() ELSE completed_at END,
    cancel_reason = CASE WHEN _to_state = 'cancelled' THEN COALESCE(_reason, cancel_reason) ELSE cancel_reason END,
    payload = payload || COALESCE(_payload_patch,'{}'::jsonb),
    updated_at = now()
  WHERE id = _task_id
  RETURNING * INTO t;

  RETURN t;
END $function$;

CREATE OR REPLACE FUNCTION public.wms_claim_next_task(_warehouse_id uuid, _task_types wms_task_type[] DEFAULT NULL::wms_task_type[], _zone_id uuid DEFAULT NULL::uuid, _lease_seconds integer DEFAULT 300)
RETURNS wms_tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  t public.wms_tasks;
BEGIN
  SELECT * INTO t
  FROM public.wms_tasks
  WHERE warehouse_id = _warehouse_id
    AND state IN ('pending','available')
    AND (_task_types IS NULL OR task_type = ANY(_task_types))
    AND (_zone_id IS NULL OR zone_id = _zone_id OR zone_id IS NULL)
    AND (expires_at IS NULL OR expires_at > now())
  ORDER BY priority DESC, created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Event emission is owned by trg_wms_tasks_emit.
  UPDATE public.wms_tasks SET
    state = 'claimed',
    claimed_by = auth.uid(),
    claimed_at = now(),
    heartbeat_at = now(),
    expires_at = now() + make_interval(secs => _lease_seconds),
    assignee_user_id = auth.uid(),
    row_version = t.row_version + 1,
    updated_at = now()
  WHERE id = t.id
  RETURNING * INTO t;

  RETURN t;
END $function$;
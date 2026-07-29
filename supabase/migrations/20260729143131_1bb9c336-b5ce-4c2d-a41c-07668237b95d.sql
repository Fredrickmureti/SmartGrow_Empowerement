
-- 1. Enum values (safe within a tx; not used as literals in this migration).
ALTER TYPE public.wms_task_state ADD VALUE IF NOT EXISTS 'paused';
ALTER TYPE public.wms_task_state ADD VALUE IF NOT EXISTS 'resumed';

-- 2. Trigger — extend state->topic map and version-scope the idempotency key.
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
    WHEN 'paused'      THEN 'paused'
    WHEN 'resumed'     THEN 'resumed'
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
      'row_version',             NEW.row_version,
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
    -- Version-scoped idempotency: pause->resume->pause emits three distinct
    -- events instead of collapsing into a single row on the outbox unique index.
    'wms.task:' || NEW.id::text || ':' || v_transition || ':v' || COALESCE(NEW.row_version, 0)::text,
    COALESCE(NEW.source_doc_type, 'wms_task'),
    COALESCE(NEW.source_doc_id, NEW.id)
  );
  RETURN NULL;
END;
$function$;

-- 3. RPC — extend FSM allow-list with pause/resume edges.
CREATE OR REPLACE FUNCTION public.wms_transition_task(
  _task_id uuid,
  _to_state wms_task_state,
  _expected_version integer,
  _actor uuid DEFAULT auth.uid(),
  _reason text DEFAULT NULL,
  _payload_patch jsonb DEFAULT '{}'::jsonb
)
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
    WHEN 'assigned>claimed'       THEN TRUE
    WHEN 'assigned>in_progress'   THEN TRUE
    WHEN 'claimed>in_progress'    THEN TRUE
    WHEN 'claimed>available'      THEN TRUE
    WHEN 'claimed>exception'      THEN TRUE
    WHEN 'in_progress>completed'  THEN TRUE
    WHEN 'in_progress>done'       THEN TRUE
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

  -- Event emission is owned by trg_wms_tasks_emit.
  UPDATE public.wms_tasks SET
    state = _to_state,
    row_version = t.row_version + 1,
    started_at    = CASE WHEN _to_state IN ('in_progress','claimed') AND started_at IS NULL THEN now() ELSE started_at END,
    completed_at  = CASE WHEN _to_state IN ('completed','done') THEN now() ELSE completed_at END,
    cancel_reason = CASE WHEN _to_state = 'cancelled' THEN COALESCE(_reason, cancel_reason) ELSE cancel_reason END,
    payload = payload || COALESCE(_payload_patch,'{}'::jsonb),
    updated_at = now()
  WHERE id = _task_id
  RETURNING * INTO t;

  RETURN t;
END $function$;

-- 4. View — keep paused/resumed rows visible to supervisors.
CREATE OR REPLACE VIEW public.wms_labour_queue_view
WITH (security_invoker = true) AS
SELECT
  t.id                       AS task_id,
  t.task_type,
  t.state,
  t.priority,
  t.sla_at,
  t.warehouse_id,
  t.branch_id,
  t.organization_id,
  t.business_id,
  t.zone_id,
  t.assignee_user_id,
  t.claimed_by,
  t.claimed_at,
  t.expires_at,
  t.source_location_id,
  t.destination_location_id,
  t.product_id,
  t.lot_number,
  t.lpn_id,
  t.quantity,
  t.source_doc_type,
  t.source_doc_id,
  t.row_version,
  t.created_at,
  t.updated_at,
  (t.sla_at IS NOT NULL AND t.sla_at < now()) AS sla_breached
FROM public.wms_tasks t
WHERE t.state::text IN ('pending','available','assigned','claimed','in_progress','paused','resumed')
  AND (t.expires_at IS NULL OR t.expires_at > now());

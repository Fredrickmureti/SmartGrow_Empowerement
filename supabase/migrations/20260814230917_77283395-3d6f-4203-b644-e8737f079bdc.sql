-- Phase 7 — Workforce: optimistic concurrency on supervisor task/operator mutators.

ALTER TABLE public.wms_operators
  ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1;

DROP FUNCTION IF EXISTS public.wms_reassign_task(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.wms_release_task(uuid, text);
DROP FUNCTION IF EXISTS public.wms_set_task_priority(uuid, integer);
DROP FUNCTION IF EXISTS public.wms_set_operator_status(uuid, text);

CREATE OR REPLACE FUNCTION public._wms_task_locked(p_task_id uuid, p_expected_version integer)
RETURNS public.wms_tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_task public.wms_tasks;
BEGIN
  IF p_expected_version IS NULL THEN
    RAISE EXCEPTION 'wms_task_version_required: supervisor actions must send the row version'
      USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_task FROM public.wms_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wms_task_not_found: %', p_task_id USING ERRCODE = 'P0002';
  END IF;
  PERFORM public._wms_assert_business_access(v_task.business_id);
  IF v_task.row_version <> p_expected_version THEN
    RAISE EXCEPTION 'wms_task_stale: expected v% got v%', p_expected_version, v_task.row_version
      USING ERRCODE = '40001';
  END IF;
  RETURN v_task;
END $function$;

REVOKE ALL ON FUNCTION public._wms_task_locked(uuid, integer) FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.wms_reassign_task(
  p_task_id uuid,
  p_assignee_user_id uuid,
  p_row_version integer,
  p_reason text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_task public.wms_tasks;
BEGIN
  v_task := public._wms_task_locked(p_task_id, p_row_version);

  IF v_task.state::text IN ('completed','cancelled') THEN
    RAISE EXCEPTION 'cannot reassign task in state %', v_task.state USING ERRCODE = '22023';
  END IF;

  IF NOT public.wms_operator_can_do_task(p_assignee_user_id, p_task_id) THEN
    RAISE EXCEPTION 'operator is not eligible for this task' USING ERRCODE = '42501';
  END IF;

  UPDATE public.wms_tasks
     SET assignee_user_id = p_assignee_user_id,
         claimed_by = NULL,
         claimed_at = NULL,
         expires_at = NULL,
         state = 'claimed',
         row_version = v_task.row_version + 1,
         payload = payload || jsonb_build_object('reassign_reason', p_reason),
         updated_at = now()
   WHERE id = p_task_id;

  PERFORM public.emit_business_event(
    v_task.organization_id, v_task.business_id,
    'warehouse.task.assigned', 'wms_task', v_task.id,
    format('wms.task:%s:reassigned:%s:%s', v_task.id, p_assignee_user_id, v_task.row_version + 1),
    jsonb_build_object('task_type', v_task.task_type,
                       'assignee_user_id', p_assignee_user_id,
                       'reassigned', true, 'reason', p_reason),
    v_task.branch_id, v_task.warehouse_id
  );

  RETURN jsonb_build_object('task_id', v_task.id, 'state', 'claimed',
                            'row_version', v_task.row_version + 1);
END $function$;

CREATE OR REPLACE FUNCTION public.wms_release_task(
  p_task_id uuid,
  p_row_version integer,
  p_reason text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_task public.wms_tasks;
BEGIN
  v_task := public._wms_task_locked(p_task_id, p_row_version);

  IF v_task.state::text NOT IN ('claimed','in_progress','paused','resumed') THEN
    RAISE EXCEPTION 'cannot release task in state %', v_task.state USING ERRCODE = '22023';
  END IF;

  UPDATE public.wms_tasks
     SET state = 'available',
         assignee_user_id = NULL,
         claimed_by = NULL,
         claimed_at = NULL,
         expires_at = NULL,
         row_version = v_task.row_version + 1,
         payload = payload || jsonb_build_object('release_reason', p_reason),
         updated_at = now()
   WHERE id = p_task_id;

  PERFORM public.emit_business_event(
    v_task.organization_id, v_task.business_id,
    'warehouse.task.available', 'wms_task', v_task.id,
    format('wms.task:%s:available:%s', v_task.id, v_task.row_version + 1),
    jsonb_build_object('task_type', v_task.task_type, 'released', true, 'reason', p_reason),
    v_task.branch_id, v_task.warehouse_id
  );

  RETURN jsonb_build_object('task_id', p_task_id, 'state', 'available',
                            'row_version', v_task.row_version + 1);
END $function$;

CREATE OR REPLACE FUNCTION public.wms_set_task_priority(
  p_task_id uuid,
  p_priority integer,
  p_row_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_task public.wms_tasks;
BEGIN
  v_task := public._wms_task_locked(p_task_id, p_row_version);

  UPDATE public.wms_tasks
     SET priority = p_priority,
         row_version = v_task.row_version + 1,
         updated_at = now()
   WHERE id = p_task_id;

  RETURN jsonb_build_object('task_id', p_task_id, 'priority', p_priority,
                            'row_version', v_task.row_version + 1);
END $function$;

CREATE OR REPLACE FUNCTION public.wms_set_operator_status(
  p_operator_id uuid,
  p_status text,
  p_row_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  op public.wms_operators;
BEGIN
  IF p_row_version IS NULL THEN
    RAISE EXCEPTION 'wms_operator_version_required: send the row version you read'
      USING ERRCODE = '22023';
  END IF;
  IF p_status NOT IN ('off_shift','on_shift','break','executing') THEN
    RAISE EXCEPTION 'invalid operator status %', p_status USING ERRCODE = '22023';
  END IF;

  SELECT * INTO op FROM public.wms_operators WHERE id = p_operator_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operator % not found', p_operator_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM public._wms_assert_business_access(op.business_id);

  IF op.row_version <> p_row_version THEN
    RAISE EXCEPTION 'wms_operator_stale: expected v% got v%', p_row_version, op.row_version
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.wms_operators
     SET status = p_status,
         status_changed_at = now(),
         row_version = op.row_version + 1
   WHERE id = p_operator_id;

  RETURN jsonb_build_object('operator_id', p_operator_id, 'status', p_status,
                            'row_version', op.row_version + 1);
END $function$;

REVOKE ALL ON FUNCTION public.wms_reassign_task(uuid, uuid, integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.wms_release_task(uuid, integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.wms_set_task_priority(uuid, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.wms_set_operator_status(uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wms_reassign_task(uuid, uuid, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wms_release_task(uuid, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wms_set_task_priority(uuid, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wms_set_operator_status(uuid, text, integer) TO authenticated;
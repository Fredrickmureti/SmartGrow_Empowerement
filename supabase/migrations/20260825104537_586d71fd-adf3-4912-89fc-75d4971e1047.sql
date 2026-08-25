CREATE OR REPLACE FUNCTION public._project_task_assert_writable(_task_id uuid)
RETURNS public.project_tasks
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task public.project_tasks;
  v_status text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_task FROM public.project_tasks WHERE id = _task_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.project_can_write(v_task.project_id, auth.uid()) THEN
    RAISE EXCEPTION 'You do not have write access to this project' USING ERRCODE = '42501';
  END IF;

  SELECT status INTO v_status FROM public.projects WHERE id = v_task.project_id;
  IF v_status IN ('completed','cancelled') THEN
    RAISE EXCEPTION 'This project is % — reopen it before changing its tasks', v_status
      USING ERRCODE = '23514';
  END IF;

  RETURN v_task;
END;
$$;

REVOKE EXECUTE ON FUNCTION public._project_task_assert_writable(uuid) FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.project_task_complete(_task_id uuid)
RETURNS public.project_tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task public.project_tasks;
  v_row public.project_tasks;
  v_open integer;
BEGIN
  v_task := public._project_task_assert_writable(_task_id);

  IF v_task.is_done THEN
    RETURN v_task;
  END IF;

  IF v_task.depends_on IS NOT NULL AND array_length(v_task.depends_on, 1) > 0
     AND v_task.blocked_override_by IS NULL THEN
    SELECT count(*) INTO v_open
    FROM public.project_tasks d
    WHERE d.id = ANY (v_task.depends_on) AND d.is_active AND NOT d.is_done;
    IF v_open > 0 THEN
      RAISE EXCEPTION 'Cannot complete: % predecessor task(s) are still open', v_open
        USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE public.project_tasks SET
    is_done = true,
    progress = 100,
    completed_at = now(),
    completed_by = auth.uid(),
    updated_at = now()
  WHERE id = _task_id
  RETURNING * INTO v_row;

  PERFORM public.project_log_activity(
    v_row.project_id, 'task_completed',
    format('Task %s completed', v_row.task_number),
    jsonb_build_object('task_id', v_row.id));

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.project_task_reopen(_task_id uuid)
RETURNS public.project_tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task public.project_tasks;
  v_row public.project_tasks;
BEGIN
  v_task := public._project_task_assert_writable(_task_id);

  IF NOT v_task.is_done THEN
    RETURN v_task;
  END IF;

  UPDATE public.project_tasks SET
    is_done = false,
    progress = 0,
    completed_at = NULL,
    completed_by = NULL,
    updated_at = now()
  WHERE id = _task_id
  RETURNING * INTO v_row;

  PERFORM public.project_log_activity(
    v_row.project_id, 'task_reopened',
    format('Task %s reopened', v_row.task_number),
    jsonb_build_object('task_id', v_row.id));

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.project_task_move_stage(_task_id uuid, _stage_id uuid)
RETURNS public.project_tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task public.project_tasks;
  v_row public.project_tasks;
  v_stage public.project_stages;
BEGIN
  v_task := public._project_task_assert_writable(_task_id);

  SELECT * INTO v_stage FROM public.project_stages WHERE id = _stage_id;
  IF NOT FOUND OR v_stage.project_id IS DISTINCT FROM v_task.project_id THEN
    RAISE EXCEPTION 'Target stage does not belong to this project' USING ERRCODE = '23514';
  END IF;

  UPDATE public.project_tasks SET
    stage_id = _stage_id,
    is_done = v_stage.is_closed,
    progress = CASE WHEN v_stage.is_closed THEN 100 ELSE progress END,
    completed_at = CASE WHEN v_stage.is_closed THEN COALESCE(completed_at, now()) ELSE NULL END,
    completed_by = CASE WHEN v_stage.is_closed THEN COALESCE(completed_by, auth.uid()) ELSE NULL END,
    updated_at = now()
  WHERE id = _task_id
  RETURNING * INTO v_row;

  PERFORM public.project_log_activity(
    v_row.project_id, 'task_stage_changed',
    format('Task %s moved to stage %s', v_row.task_number, v_stage.name),
    jsonb_build_object('task_id', v_row.id, 'stage_id', _stage_id));

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.project_task_assign(_task_id uuid, _user_id uuid)
RETURNS public.project_tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task public.project_tasks;
  v_row public.project_tasks;
BEGIN
  v_task := public._project_task_assert_writable(_task_id);

  IF _user_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.project_members m
       WHERE m.project_id = v_task.project_id AND m.user_id = _user_id
     )
     AND NOT public.project_is_governor(v_task.project_id, _user_id) THEN
    RAISE EXCEPTION 'Assignee is not a member of this project team' USING ERRCODE = '23514';
  END IF;

  UPDATE public.project_tasks SET assigned_to = _user_id, updated_at = now()
  WHERE id = _task_id
  RETURNING * INTO v_row;

  PERFORM public.project_log_activity(
    v_row.project_id,
    CASE WHEN _user_id IS NULL THEN 'task_unassigned' ELSE 'task_assigned' END,
    format('Task %s %s', v_row.task_number,
           CASE WHEN _user_id IS NULL THEN 'unassigned' ELSE 'assigned' END),
    jsonb_build_object('task_id', v_row.id, 'assigned_to', _user_id));

  RETURN v_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.project_task_complete(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.project_task_reopen(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.project_task_move_stage(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.project_task_assign(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.project_task_complete(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.project_task_reopen(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.project_task_move_stage(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.project_task_assign(uuid, uuid) TO authenticated;
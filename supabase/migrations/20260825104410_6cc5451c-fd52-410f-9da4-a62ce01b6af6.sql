-- Allowed project lifecycle transitions.
CREATE OR REPLACE FUNCTION public.project_status_transition_allowed(_from text, _to text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN _from = _to THEN true
    WHEN _from = 'draft'     AND _to IN ('active','cancelled') THEN true
    WHEN _from = 'active'    AND _to IN ('on_hold','completed','cancelled') THEN true
    WHEN _from = 'on_hold'   AND _to IN ('active','cancelled','completed') THEN true
    WHEN _from = 'completed' AND _to IN ('active') THEN true
    WHEN _from = 'cancelled' AND _to IN ('draft','active') THEN true
    ELSE false
  END;
$$;

-- Server-written activity trail for project-level events.
CREATE OR REPLACE FUNCTION public.project_log_activity(
  _project_id uuid,
  _event_type text,
  _summary text,
  _payload jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_biz uuid;
BEGIN
  SELECT organization_id, business_id INTO v_org, v_biz
  FROM public.projects WHERE id = _project_id;

  INSERT INTO public.project_activity_log
    (organization_id, business_id, project_id, actor_id, event_type, summary, payload)
  VALUES (v_org, v_biz, _project_id, auth.uid(), _event_type, _summary, COALESCE(_payload, '{}'::jsonb));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.project_log_activity(uuid, text, text, jsonb) FROM PUBLIC, anon;

-- Reasons a project may not be closed. Empty array = closable.
CREATE OR REPLACE FUNCTION public.project_closure_blockers(_project_id uuid)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_blockers text[] := '{}';
  v_n integer;
BEGIN
  SELECT count(*) INTO v_n
  FROM public.project_tasks t
  WHERE t.project_id = _project_id AND t.is_active AND NOT t.is_done;
  IF v_n > 0 THEN
    v_blockers := v_blockers || format('%s open task(s) must be completed or cancelled', v_n);
  END IF;

  SELECT count(*) INTO v_n
  FROM public.timesheets ts
  WHERE ts.project_id = _project_id
    AND COALESCE(ts.status, 'draft') NOT IN ('approved','rejected');
  IF v_n > 0 THEN
    v_blockers := v_blockers || format('%s time entr(y/ies) still awaiting approval', v_n);
  END IF;

  SELECT count(*) INTO v_n
  FROM public.project_milestones m
  JOIN public.projects p ON p.id = m.project_id
  WHERE m.project_id = _project_id
    AND m.is_reached
    AND p.is_billable
    AND NOT EXISTS (
      SELECT 1 FROM public.project_revenue_entries r
      WHERE r.milestone_id = m.id AND r.invoice_id IS NOT NULL
    );
  IF v_n > 0 THEN
    v_blockers := v_blockers || format('%s reached milestone(s) not yet invoiced', v_n);
  END IF;

  RETURN v_blockers;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.project_closure_blockers(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.project_closure_blockers(uuid) TO authenticated;

-- Governed lifecycle command.
CREATE OR REPLACE FUNCTION public.project_change_status(
  _project_id uuid,
  _status text,
  _expected_version integer DEFAULT NULL,
  _reason text DEFAULT NULL
)
RETURNS public.projects
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_old public.projects;
  v_row public.projects;
  v_blockers text[];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF _status NOT IN ('draft','active','on_hold','completed','cancelled') THEN
    RAISE EXCEPTION 'Unknown project status %', _status USING ERRCODE = '22023';
  END IF;
  IF NOT public.project_is_governor(_project_id, v_uid) THEN
    RAISE EXCEPTION 'Only an administrator or the project manager can change project status'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_old FROM public.projects WHERE id = _project_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF _expected_version IS NOT NULL AND v_old.version IS DISTINCT FROM _expected_version THEN
    RAISE EXCEPTION 'This project was changed by someone else (version %, you had %). Reload and retry.',
      v_old.version, _expected_version USING ERRCODE = '40001';
  END IF;

  IF v_old.status = _status THEN
    RETURN v_old;
  END IF;

  IF NOT public.project_status_transition_allowed(v_old.status, _status) THEN
    RAISE EXCEPTION 'Cannot move a project from % to %', v_old.status, _status
      USING ERRCODE = '22023';
  END IF;

  IF _status = 'completed' THEN
    v_blockers := public.project_closure_blockers(_project_id);
    IF array_length(v_blockers, 1) > 0 THEN
      RAISE EXCEPTION 'Project cannot be closed: %', array_to_string(v_blockers, '; ')
        USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE public.projects p SET
    status = _status,
    actual_start_date = CASE
      WHEN _status = 'active' AND p.actual_start_date IS NULL THEN CURRENT_DATE
      ELSE p.actual_start_date END,
    actual_end_date = CASE
      WHEN _status IN ('completed','cancelled') THEN coalesce(p.actual_end_date, CURRENT_DATE)
      ELSE NULL END,
    updated_at = now()
  WHERE p.id = _project_id
  RETURNING * INTO v_row;

  PERFORM public.project_log_activity(
    _project_id,
    'project_status_changed',
    format('Project status changed from %s to %s', v_old.status, _status),
    jsonb_build_object('from', v_old.status, 'to', _status, 'reason', _reason, 'version', v_row.version)
  );

  RETURN v_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.project_change_status(uuid, text, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.project_change_status(uuid, text, integer, text) TO authenticated;
CREATE TABLE IF NOT EXISTS public.project_burndown_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  snapshot_date date NOT NULL DEFAULT CURRENT_DATE,
  planned_hours numeric NOT NULL DEFAULT 0,
  logged_hours numeric NOT NULL DEFAULT 0,
  remaining_hours numeric NOT NULL DEFAULT 0,
  open_tasks integer NOT NULL DEFAULT 0,
  done_tasks integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_burndown_unique_day UNIQUE (project_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_project_burndown_project_date
  ON public.project_burndown_daily (project_id, snapshot_date DESC);

ALTER TABLE public.project_burndown_daily ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Project access reads burndown"
  ON public.project_burndown_daily FOR SELECT TO authenticated
  USING (public.can_access_project(project_id, auth.uid()));

CREATE POLICY "Managers write burndown"
  ON public.project_burndown_daily FOR ALL TO authenticated
  USING (public.can_manage_project_financials(project_id, auth.uid()))
  WITH CHECK (public.can_manage_project_financials(project_id, auth.uid()));

CREATE OR REPLACE FUNCTION public.snapshot_project_burndown(_project_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_planned numeric := 0;
  v_logged numeric := 0;
  v_open int := 0;
  v_done int := 0;
BEGIN
  SELECT organization_id INTO v_org FROM public.projects WHERE id = _project_id;
  IF v_org IS NULL THEN RETURN; END IF;

  SELECT
    COALESCE(SUM(planned_hours), 0),
    COALESCE(SUM(effective_hours), 0),
    COUNT(*) FILTER (WHERE NOT is_done),
    COUNT(*) FILTER (WHERE is_done)
  INTO v_planned, v_logged, v_open, v_done
  FROM public.project_tasks
  WHERE project_id = _project_id;

  INSERT INTO public.project_burndown_daily
    (organization_id, project_id, snapshot_date, planned_hours, logged_hours, remaining_hours, open_tasks, done_tasks)
  VALUES
    (v_org, _project_id, CURRENT_DATE, v_planned, v_logged, GREATEST(v_planned - v_logged, 0), v_open, v_done)
  ON CONFLICT (project_id, snapshot_date) DO UPDATE
    SET planned_hours = EXCLUDED.planned_hours,
        logged_hours = EXCLUDED.logged_hours,
        remaining_hours = EXCLUDED.remaining_hours,
        open_tasks = EXCLUDED.open_tasks,
        done_tasks = EXCLUDED.done_tasks;
END;
$$;

CREATE OR REPLACE FUNCTION public.snapshot_all_active_burndowns()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  n int := 0;
BEGIN
  FOR r IN
    SELECT id FROM public.projects WHERE COALESCE(status, 'active') IN ('active', 'on_hold')
  LOOP
    PERFORM public.snapshot_project_burndown(r.id);
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.snapshot_project_burndown(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.snapshot_all_active_burndowns() TO service_role;
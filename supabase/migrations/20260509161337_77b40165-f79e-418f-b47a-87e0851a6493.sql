ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS default_billable_rate numeric(14,4);

ALTER TABLE public.project_members
  ADD COLUMN IF NOT EXISTS billable_rate numeric(14,4);

ALTER TABLE public.project_tasks
  ADD COLUMN IF NOT EXISTS is_portal_visible boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_project_tasks_portal_visible
  ON public.project_tasks (project_id) WHERE is_portal_visible = true;

CREATE OR REPLACE FUNCTION public.resolve_timesheet_billing_rate(_timesheet_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    t.billing_rate,
    pm.billable_rate,
    p.default_billable_rate,
    0
  )::numeric
  FROM public.timesheets t
  LEFT JOIN public.projects p ON p.id = t.project_id
  LEFT JOIN public.employees e ON e.id = t.employee_id
  LEFT JOIN public.project_members pm
    ON pm.project_id = t.project_id AND pm.user_id = e.user_id
  WHERE t.id = _timesheet_id
  LIMIT 1
$$;

COMMENT ON COLUMN public.projects.default_billable_rate IS
  'Project-level default billable rate. Used when project_members.billable_rate and timesheets.billing_rate are NULL.';
COMMENT ON COLUMN public.project_members.billable_rate IS
  'Per-member override of projects.default_billable_rate.';
COMMENT ON COLUMN public.project_tasks.is_portal_visible IS
  'When true, project members (incl. portal users) can see this task via the portal RLS policy.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='project_tasks' AND policyname='portal_members_can_view_visible_tasks') THEN
    DROP POLICY "portal_members_can_view_visible_tasks" ON public.project_tasks;
  END IF;
END $$;

CREATE POLICY "portal_members_can_view_visible_tasks"
  ON public.project_tasks
  FOR SELECT
  TO authenticated
  USING (
    is_portal_visible = true
    AND EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = project_tasks.project_id
        AND pm.user_id = auth.uid()
    )
  );
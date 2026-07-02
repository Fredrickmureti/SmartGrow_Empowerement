
CREATE TABLE IF NOT EXISTS public.project_activity_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL,
  business_id UUID,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  task_id UUID REFERENCES public.project_tasks(id) ON DELETE SET NULL,
  milestone_id UUID REFERENCES public.project_milestones(id) ON DELETE SET NULL,
  actor_id UUID,
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_activity_log_project_created ON public.project_activity_log (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_activity_log_task ON public.project_activity_log (task_id);
ALTER TABLE public.project_activity_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "activity_log_select" ON public.project_activity_log;
CREATE POLICY "activity_log_select" ON public.project_activity_log FOR SELECT TO authenticated
  USING (public.can_access_project(project_id, auth.uid()));

CREATE TABLE IF NOT EXISTS public.task_followers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES public.project_tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_task_followers_task ON public.task_followers (task_id);
CREATE INDEX IF NOT EXISTS idx_task_followers_user ON public.task_followers (user_id);
ALTER TABLE public.task_followers ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public._project_id_for_task(_task_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT project_id FROM public.project_tasks WHERE id = _task_id
$$;

DROP POLICY IF EXISTS "task_followers_select" ON public.task_followers;
CREATE POLICY "task_followers_select" ON public.task_followers FOR SELECT TO authenticated
  USING (public.can_access_project(public._project_id_for_task(task_id), auth.uid()));
DROP POLICY IF EXISTS "task_followers_self_insert" ON public.task_followers;
CREATE POLICY "task_followers_self_insert" ON public.task_followers FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.can_access_project(public._project_id_for_task(task_id), auth.uid()));
DROP POLICY IF EXISTS "task_followers_self_delete" ON public.task_followers;
CREATE POLICY "task_followers_self_delete" ON public.task_followers FOR DELETE TO authenticated
  USING (user_id = auth.uid() AND public.can_access_project(public._project_id_for_task(task_id), auth.uid()));

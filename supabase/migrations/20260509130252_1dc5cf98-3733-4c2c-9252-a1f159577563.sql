-- ============ R3-tail: blocker override ============
ALTER TABLE public.project_tasks
  ADD COLUMN IF NOT EXISTS blocked_override_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS blocked_override_at timestamptz,
  ADD COLUMN IF NOT EXISTS blocked_override_reason text;

CREATE INDEX IF NOT EXISTS idx_project_tasks_blocked_override
  ON public.project_tasks (blocked_override_by) WHERE blocked_override_by IS NOT NULL;

-- ============ R3-tail: cycle pre-validate RPC (UX hint; trigger remains the hard guard) ============
CREATE OR REPLACE FUNCTION public.validate_task_dependency_no_cycle(
  _task_id uuid,
  _depends_on_id uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_cycle boolean := false;
BEGIN
  IF _task_id IS NULL OR _depends_on_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_args');
  END IF;
  IF _task_id = _depends_on_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'self_dependency');
  END IF;

  WITH RECURSIVE chain(id) AS (
    SELECT _depends_on_id
    UNION
    SELECT unnest(t.depends_on)
    FROM public.project_tasks t
    JOIN chain c ON c.id = t.id
    WHERE t.depends_on IS NOT NULL
  )
  SELECT EXISTS (SELECT 1 FROM chain WHERE id = _task_id) INTO v_cycle;

  IF v_cycle THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cycle_detected');
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.validate_task_dependency_no_cycle(uuid, uuid) TO authenticated;

-- ============ R6: tasks_due_soon for notifications cron ============
CREATE OR REPLACE FUNCTION public.tasks_due_soon(
  _org uuid,
  _biz uuid DEFAULT NULL,
  _within_days int DEFAULT 2
) RETURNS TABLE (
  task_id uuid,
  project_id uuid,
  task_name text,
  deadline date,
  assigned_to uuid,
  assignees uuid[]
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT t.id, t.project_id, t.name, t.deadline::date, t.assigned_to, t.assignees
  FROM public.project_tasks t
  JOIN public.projects p ON p.id = t.project_id
  WHERE t.organization_id = _org
    AND (_biz IS NULL OR p.business_id = _biz)
    AND t.is_done = false
    AND t.is_active = true
    AND t.deadline IS NOT NULL
    AND t.deadline::date BETWEEN CURRENT_DATE AND (CURRENT_DATE + (_within_days || ' days')::interval)::date
$$;
GRANT EXECUTE ON FUNCTION public.tasks_due_soon(uuid, uuid, int) TO authenticated;

-- ============ R7: project_templates ============
CREATE TABLE IF NOT EXISTS public.project_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  default_stages jsonb NOT NULL DEFAULT '[]'::jsonb,
  default_tags text[] NOT NULL DEFAULT '{}',
  default_milestones jsonb NOT NULL DEFAULT '[]'::jsonb,
  default_tasks jsonb NOT NULL DEFAULT '[]'::jsonb,
  default_billable boolean NOT NULL DEFAULT false,
  default_currency text,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.project_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "project_templates_org_read" ON public.project_templates;
CREATE POLICY "project_templates_org_read" ON public.project_templates
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.profiles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "project_templates_org_write" ON public.project_templates;
CREATE POLICY "project_templates_org_write" ON public.project_templates
  FOR ALL TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.profiles WHERE user_id = auth.uid()))
  WITH CHECK (organization_id IN (SELECT organization_id FROM public.profiles WHERE user_id = auth.uid()));

CREATE INDEX IF NOT EXISTS idx_project_templates_org ON public.project_templates(organization_id, business_id);

-- ============ R7: apply_project_template RPC ============
CREATE OR REPLACE FUNCTION public.apply_project_template(
  _template_id uuid,
  _project_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_t public.project_templates;
  v_p public.projects;
  v_stage jsonb;
  v_ms jsonb;
  v_task jsonb;
  v_count_stages int := 0;
  v_count_milestones int := 0;
  v_count_tasks int := 0;
BEGIN
  SELECT * INTO v_t FROM public.project_templates WHERE id = _template_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'template_not_found'; END IF;
  SELECT * INTO v_p FROM public.projects WHERE id = _project_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'project_not_found'; END IF;
  IF v_p.organization_id <> v_t.organization_id THEN
    RAISE EXCEPTION 'org_mismatch';
  END IF;

  FOR v_stage IN SELECT * FROM jsonb_array_elements(coalesce(v_t.default_stages, '[]'::jsonb))
  LOOP
    INSERT INTO public.project_stages (organization_id, project_id, name, color, sequence, is_closed)
    VALUES (
      v_p.organization_id, v_p.id,
      v_stage->>'name',
      v_stage->>'color',
      coalesce((v_stage->>'sequence')::int, v_count_stages * 10),
      coalesce((v_stage->>'is_closed')::boolean, false)
    );
    v_count_stages := v_count_stages + 1;
  END LOOP;

  FOR v_ms IN SELECT * FROM jsonb_array_elements(coalesce(v_t.default_milestones, '[]'::jsonb))
  LOOP
    INSERT INTO public.project_milestones (organization_id, project_id, name, description, target_date)
    VALUES (
      v_p.organization_id, v_p.id,
      v_ms->>'name', v_ms->>'description',
      NULLIF(v_ms->>'target_date','')::date
    );
    v_count_milestones := v_count_milestones + 1;
  END LOOP;

  FOR v_task IN SELECT * FROM jsonb_array_elements(coalesce(v_t.default_tasks, '[]'::jsonb))
  LOOP
    INSERT INTO public.project_tasks (organization_id, project_id, name, description, planned_hours, priority)
    VALUES (
      v_p.organization_id, v_p.id,
      v_task->>'name', v_task->>'description',
      NULLIF(v_task->>'planned_hours','')::numeric,
      coalesce((v_task->>'priority')::int, 0)
    );
    v_count_tasks := v_count_tasks + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'stages', v_count_stages,
    'milestones', v_count_milestones,
    'tasks', v_count_tasks
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.apply_project_template(uuid, uuid) TO authenticated;

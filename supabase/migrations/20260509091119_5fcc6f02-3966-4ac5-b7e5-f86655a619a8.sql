
-- =========================================================================
-- PROJECTS APP — STAGE 3: STORAGE BUCKET + COMMENTS + RPC SCOPING
-- =========================================================================

-- ---------- 1. project-documents storage bucket --------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'project-documents',
  'project-documents',
  false,
  52428800, -- 50 MB
  ARRAY[
    'application/pdf','image/jpeg','image/png','image/webp','image/gif',
    'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain','text/csv','application/zip'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS — paths shaped as: {organization_id}/{project_id}/...
CREATE POLICY "project-documents read"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'project-documents'
    AND EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id::text = (storage.foldername(name))[2]
        AND public.can_access_project(p.id, auth.uid())
    )
  );

CREATE POLICY "project-documents insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'project-documents'
    AND EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id::text = (storage.foldername(name))[2]
        AND public.can_access_project(p.id, auth.uid())
    )
  );

CREATE POLICY "project-documents update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'project-documents'
    AND EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id::text = (storage.foldername(name))[2]
        AND public.can_access_project(p.id, auth.uid())
    )
  );

CREATE POLICY "project-documents delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'project-documents'
    AND EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id::text = (storage.foldername(name))[2]
        AND public.can_access_project(p.id, auth.uid())
    )
  );

-- ---------- 2. task_comments table ---------------------------------------
CREATE TABLE IF NOT EXISTS public.task_comments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  task_id         uuid NOT NULL REFERENCES public.project_tasks(id) ON DELETE CASCADE,
  body            text NOT NULL,
  author_id       uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON public.task_comments(task_id, created_at);

ALTER TABLE public.task_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Project access reads task comments"
  ON public.task_comments FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.project_tasks t
      WHERE t.id = task_comments.task_id
        AND public.can_access_project(t.project_id, auth.uid())
    )
  );

CREATE POLICY "Project access writes task comments"
  ON public.task_comments FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.project_tasks t
      WHERE t.id = task_comments.task_id
        AND public.can_access_project(t.project_id, auth.uid())
    )
    AND author_id = auth.uid()
  );

CREATE POLICY "Authors update own task comments"
  ON public.task_comments FOR UPDATE TO authenticated
  USING (author_id = auth.uid())
  WITH CHECK (author_id = auth.uid());

CREATE POLICY "Authors delete own task comments"
  ON public.task_comments FOR DELETE TO authenticated
  USING (author_id = auth.uid());

-- Maintain project_tasks.comment_count
CREATE OR REPLACE FUNCTION public.sync_task_comment_count()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.project_tasks SET comment_count = comment_count + 1 WHERE id = NEW.task_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.project_tasks SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = OLD.task_id;
  END IF;
  RETURN NULL;
END; $$;

DROP TRIGGER IF EXISTS trg_task_comments_count ON public.task_comments;
CREATE TRIGGER trg_task_comments_count
  AFTER INSERT OR DELETE ON public.task_comments
  FOR EACH ROW EXECUTE FUNCTION public.sync_task_comment_count();

-- Same for task_attachments.attachment_count
CREATE OR REPLACE FUNCTION public.sync_task_attachment_count()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.project_tasks SET attachment_count = attachment_count + 1 WHERE id = NEW.task_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.project_tasks SET attachment_count = GREATEST(attachment_count - 1, 0) WHERE id = OLD.task_id;
  END IF;
  RETURN NULL;
END; $$;

DROP TRIGGER IF EXISTS trg_task_attachments_count ON public.task_attachments;
CREATE TRIGGER trg_task_attachments_count
  AFTER INSERT OR DELETE ON public.task_attachments
  FOR EACH ROW EXECUTE FUNCTION public.sync_task_attachment_count();

-- And subtask_count via parent_task_id
CREATE OR REPLACE FUNCTION public.sync_subtask_count()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.parent_task_id IS NOT NULL THEN
    UPDATE public.project_tasks SET subtask_count = subtask_count + 1 WHERE id = NEW.parent_task_id;
  ELSIF TG_OP = 'DELETE' AND OLD.parent_task_id IS NOT NULL THEN
    UPDATE public.project_tasks SET subtask_count = GREATEST(subtask_count - 1, 0) WHERE id = OLD.parent_task_id;
  ELSIF TG_OP = 'UPDATE' AND COALESCE(OLD.parent_task_id::text,'') <> COALESCE(NEW.parent_task_id::text,'') THEN
    IF OLD.parent_task_id IS NOT NULL THEN
      UPDATE public.project_tasks SET subtask_count = GREATEST(subtask_count - 1, 0) WHERE id = OLD.parent_task_id;
    END IF;
    IF NEW.parent_task_id IS NOT NULL THEN
      UPDATE public.project_tasks SET subtask_count = subtask_count + 1 WHERE id = NEW.parent_task_id;
    END IF;
  END IF;
  RETURN NULL;
END; $$;

DROP TRIGGER IF EXISTS trg_project_tasks_subtask_count ON public.project_tasks;
CREATE TRIGGER trg_project_tasks_subtask_count
  AFTER INSERT OR UPDATE OR DELETE ON public.project_tasks
  FOR EACH ROW EXECUTE FUNCTION public.sync_subtask_count();

-- ---------- 3. compute_project_profitability — overload with business_id -
CREATE OR REPLACE FUNCTION public.compute_project_profitability(
  _project_id uuid,
  _business_id uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_proj public.projects%ROWTYPE;
  v_cost numeric := 0;
  v_revenue numeric := 0;
  v_planned_hours numeric := 0;
  v_logged_hours numeric := 0;
  v_cost_breakdown jsonb;
  v_revenue_breakdown jsonb;
BEGIN
  SELECT * INTO v_proj FROM public.projects WHERE id = _project_id;
  IF v_proj.id IS NULL THEN
    RAISE EXCEPTION 'Project % not found', _project_id;
  END IF;
  IF NOT public.can_access_project(_project_id, auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT COALESCE(SUM(amount),0) INTO v_cost
  FROM public.project_cost_entries
  WHERE project_id = _project_id
    AND (_business_id IS NULL OR business_id = _business_id);

  SELECT COALESCE(SUM(amount),0) INTO v_revenue
  FROM public.project_revenue_entries
  WHERE project_id = _project_id
    AND (_business_id IS NULL OR business_id = _business_id);

  SELECT COALESCE(SUM(planned_hours),0), COALESCE(SUM(effective_hours),0)
    INTO v_planned_hours, v_logged_hours
  FROM public.project_tasks
  WHERE project_id = _project_id AND is_active = true;

  SELECT COALESCE(jsonb_object_agg(source_type, total),'{}'::jsonb) INTO v_cost_breakdown
  FROM (
    SELECT source_type, SUM(amount) AS total
    FROM public.project_cost_entries
    WHERE project_id = _project_id
      AND (_business_id IS NULL OR business_id = _business_id)
    GROUP BY source_type
  ) c;

  SELECT COALESCE(jsonb_object_agg(source_type, total),'{}'::jsonb) INTO v_revenue_breakdown
  FROM (
    SELECT source_type, SUM(amount) AS total
    FROM public.project_revenue_entries
    WHERE project_id = _project_id
      AND (_business_id IS NULL OR business_id = _business_id)
    GROUP BY source_type
  ) r;

  RETURN jsonb_build_object(
    'project_id', _project_id,
    'business_id', _business_id,
    'currency', v_proj.currency,
    'cost_total', v_cost,
    'revenue_total', v_revenue,
    'margin', v_revenue - v_cost,
    'margin_pct', CASE WHEN v_revenue = 0 THEN NULL ELSE round(((v_revenue - v_cost) / v_revenue) * 100, 2) END,
    'planned_hours', v_planned_hours,
    'logged_hours', v_logged_hours,
    'budget', v_proj.budget,
    'budget_used_pct', CASE WHEN v_proj.budget IS NULL OR v_proj.budget = 0 THEN NULL ELSE round((v_cost / v_proj.budget) * 100, 2) END,
    'cost_by_source', v_cost_breakdown,
    'revenue_by_source', v_revenue_breakdown
  );
END; $$;

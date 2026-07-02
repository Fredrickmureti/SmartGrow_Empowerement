
-- ============================================================================
-- Step 3 — RLS hardening + project notification triggers + dedupe index
-- ============================================================================

-- 1. Margin alert threshold column on projects (nullable = off)
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS margin_alert_threshold numeric;

-- 2. Helper: can the user write financial entries for this project?
--    Org admin/owner OR project manager.
CREATE OR REPLACE FUNCTION public.can_manage_project_financials(_project_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = _project_id
      AND (
        public.is_org_admin(_user_id, p.organization_id)
        OR p.manager_id = _user_id
      )
  );
$$;

-- 3. Tighten write policies on revenue/cost entries
DROP POLICY IF EXISTS "Managers insert manual revenue entries" ON public.project_revenue_entries;
DROP POLICY IF EXISTS "Managers update manual revenue entries" ON public.project_revenue_entries;
DROP POLICY IF EXISTS "Managers delete manual revenue entries" ON public.project_revenue_entries;
CREATE POLICY "Financial managers manage revenue entries"
  ON public.project_revenue_entries FOR ALL
  USING (public.can_manage_project_financials(project_id, auth.uid()))
  WITH CHECK (public.can_manage_project_financials(project_id, auth.uid()));

DROP POLICY IF EXISTS "Managers insert manual cost entries" ON public.project_cost_entries;
DROP POLICY IF EXISTS "Managers update manual cost entries" ON public.project_cost_entries;
DROP POLICY IF EXISTS "Managers delete manual cost entries" ON public.project_cost_entries;
CREATE POLICY "Financial managers manage cost entries"
  ON public.project_cost_entries FOR ALL
  USING (public.can_manage_project_financials(project_id, auth.uid()))
  WITH CHECK (public.can_manage_project_financials(project_id, auth.uid()));

-- 4. Notification triggers
-- 4a. Task assigned (insert OR assignee change)
CREATE OR REPLACE FUNCTION public.notify_task_assigned()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_assignee uuid;
  v_project_name text;
BEGIN
  IF NEW.assigned_to IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND COALESCE(OLD.assigned_to::text,'') = COALESCE(NEW.assigned_to::text,'') THEN
    RETURN NEW;
  END IF;
  SELECT name INTO v_project_name FROM public.projects WHERE id = NEW.project_id;
  PERFORM public.create_notification(
    NEW.organization_id,
    NEW.assigned_to,
    'task_assigned',
    'tasks',
    'Task assigned to you',
    COALESCE(v_project_name,'Project') || ' · ' || NEW.name,
    '/projects-app/' || NEW.project_id::text || '/tasks?task=' || NEW.id::text,
    'project_task',
    NEW.id,
    1,
    NEW.business_id
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_task_assigned ON public.project_tasks;
CREATE TRIGGER trg_notify_task_assigned
  AFTER INSERT OR UPDATE OF assigned_to ON public.project_tasks
  FOR EACH ROW EXECUTE FUNCTION public.notify_task_assigned();

-- 4b. Blocker added (task_dependencies insert) — notify task assignee
CREATE OR REPLACE FUNCTION public.notify_task_blocker_added()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  t record;
  v_project_name text;
BEGIN
  SELECT id, name, project_id, assigned_to, organization_id, business_id
    INTO t FROM public.project_tasks WHERE id = NEW.task_id;
  IF t.assigned_to IS NULL THEN RETURN NEW; END IF;
  SELECT name INTO v_project_name FROM public.projects WHERE id = t.project_id;
  PERFORM public.create_notification(
    t.organization_id,
    t.assigned_to,
    'task_blocker_added',
    'tasks',
    'New blocker on your task',
    COALESCE(v_project_name,'Project') || ' · ' || t.name,
    '/projects-app/' || t.project_id::text || '/tasks?task=' || t.id::text,
    'project_task',
    t.id,
    2,
    t.business_id
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_task_blocker_added ON public.task_dependencies;
CREATE TRIGGER trg_notify_task_blocker_added
  AFTER INSERT ON public.task_dependencies
  FOR EACH ROW EXECUTE FUNCTION public.notify_task_blocker_added();

-- 4c. Project status update → notify manager
CREATE OR REPLACE FUNCTION public.notify_project_status_update()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  p record;
BEGIN
  SELECT id, name, manager_id, organization_id, business_id
    INTO p FROM public.projects WHERE id = NEW.project_id;
  IF p.manager_id IS NULL OR p.manager_id = NEW.author_id THEN RETURN NEW; END IF;
  PERFORM public.create_notification(
    p.organization_id,
    p.manager_id,
    'project_status_update',
    'projects',
    'Project update posted',
    p.name || ' · ' || COALESCE(NEW.status,'update'),
    '/projects-app/' || p.id::text || '/updates',
    'project',
    p.id,
    1,
    p.business_id
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_project_status_update ON public.project_updates;
CREATE TRIGGER trg_notify_project_status_update
  AFTER INSERT ON public.project_updates
  FOR EACH ROW EXECUTE FUNCTION public.notify_project_status_update();

-- 4d. Margin alert: when a new cost or revenue entry causes margin to drop below threshold
CREATE OR REPLACE FUNCTION public.notify_project_margin_alert()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  p record;
  v_revenue numeric;
  v_cost numeric;
  v_margin_pct numeric;
BEGIN
  SELECT id, name, manager_id, organization_id, business_id, margin_alert_threshold
    INTO p FROM public.projects WHERE id = NEW.project_id;
  IF p.margin_alert_threshold IS NULL OR p.manager_id IS NULL THEN RETURN NEW; END IF;
  SELECT COALESCE(SUM(amount),0) INTO v_revenue
    FROM public.project_revenue_entries WHERE project_id = NEW.project_id;
  SELECT COALESCE(SUM(amount),0) INTO v_cost
    FROM public.project_cost_entries WHERE project_id = NEW.project_id;
  IF v_revenue <= 0 THEN RETURN NEW; END IF;
  v_margin_pct := ((v_revenue - v_cost) / v_revenue) * 100;
  IF v_margin_pct < p.margin_alert_threshold THEN
    -- Dedupe: only emit if no margin alert in last 24h for this project
    IF NOT EXISTS (
      SELECT 1 FROM public.notifications
      WHERE entity_type = 'project' AND entity_id = p.id
        AND type = 'project_margin_alert'
        AND created_at > now() - interval '24 hours'
    ) THEN
      PERFORM public.create_notification(
        p.organization_id,
        p.manager_id,
        'project_margin_alert',
        'projects',
        'Project margin below threshold',
        p.name || ' · margin ' || round(v_margin_pct, 1)::text || '% (threshold ' || p.margin_alert_threshold::text || '%)',
        '/projects-app/' || p.id::text || '/financials',
        'project',
        p.id,
        2,
        p.business_id
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_margin_alert_cost ON public.project_cost_entries;
CREATE TRIGGER trg_notify_margin_alert_cost
  AFTER INSERT ON public.project_cost_entries
  FOR EACH ROW EXECUTE FUNCTION public.notify_project_margin_alert();

DROP TRIGGER IF EXISTS trg_notify_margin_alert_rev ON public.project_revenue_entries;
CREATE TRIGGER trg_notify_margin_alert_rev
  AFTER INSERT ON public.project_revenue_entries
  FOR EACH ROW EXECUTE FUNCTION public.notify_project_margin_alert();

-- 5. Dedupe index for tasks_due_soon notifications
--    Composite unique covering (entity_type, entity_id, type, user_id, day-trunc) cannot use
--    expression in unique without immutable; emulate with partial index + check in edge fn.
CREATE INDEX IF NOT EXISTS idx_notifications_task_due_dedupe
  ON public.notifications (user_id, entity_id, type, ((created_at AT TIME ZONE 'UTC')::date))
  WHERE type IN ('task_due_soon','task_overdue');

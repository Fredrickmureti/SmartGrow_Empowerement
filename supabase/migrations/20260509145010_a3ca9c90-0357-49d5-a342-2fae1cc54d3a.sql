
CREATE OR REPLACE FUNCTION public.log_task_activity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.project_activity_log (organization_id, business_id, project_id, task_id, actor_id, event_type, summary, payload)
    VALUES (NEW.organization_id, NEW.business_id, NEW.project_id, NEW.id, NEW.created_by,
            'task_created', 'Task created: ' || NEW.name,
            jsonb_build_object('task_name', NEW.name, 'assigned_to', NEW.assigned_to));
    IF NEW.created_by IS NOT NULL THEN
      INSERT INTO public.task_followers (task_id, user_id) VALUES (NEW.id, NEW.created_by) ON CONFLICT DO NOTHING;
    END IF;
    IF NEW.assigned_to IS NOT NULL THEN
      INSERT INTO public.task_followers (task_id, user_id) VALUES (NEW.id, NEW.assigned_to) ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.is_done IS DISTINCT FROM OLD.is_done AND NEW.is_done THEN
    INSERT INTO public.project_activity_log (organization_id, business_id, project_id, task_id, actor_id, event_type, summary, payload)
    VALUES (NEW.organization_id, NEW.business_id, NEW.project_id, NEW.id, NEW.completed_by,
            'task_completed', 'Task completed: ' || NEW.name, '{}'::jsonb);
  END IF;
  IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
    INSERT INTO public.project_activity_log (organization_id, business_id, project_id, task_id, actor_id, event_type, summary, payload)
    VALUES (NEW.organization_id, NEW.business_id, NEW.project_id, NEW.id, auth.uid(),
            'task_assignee_changed', 'Task reassigned: ' || NEW.name,
            jsonb_build_object('from', OLD.assigned_to, 'to', NEW.assigned_to));
    IF NEW.assigned_to IS NOT NULL THEN
      INSERT INTO public.task_followers (task_id, user_id) VALUES (NEW.id, NEW.assigned_to) ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  IF NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    INSERT INTO public.project_activity_log (organization_id, business_id, project_id, task_id, actor_id, event_type, summary, payload)
    VALUES (NEW.organization_id, NEW.business_id, NEW.project_id, NEW.id, auth.uid(),
            'task_stage_changed', 'Stage changed: ' || NEW.name,
            jsonb_build_object('from_stage', OLD.stage_id, 'to_stage', NEW.stage_id));
  END IF;
  IF NEW.is_blocked IS DISTINCT FROM OLD.is_blocked AND NEW.is_blocked THEN
    INSERT INTO public.project_activity_log (organization_id, business_id, project_id, task_id, actor_id, event_type, summary, payload)
    VALUES (NEW.organization_id, NEW.business_id, NEW.project_id, NEW.id, auth.uid(),
            'task_blocked', 'Task blocked: ' || NEW.name,
            jsonb_build_object('reason', NEW.blocked_reason));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_log_task_activity ON public.project_tasks;
CREATE TRIGGER trg_log_task_activity AFTER INSERT OR UPDATE ON public.project_tasks
  FOR EACH ROW EXECUTE FUNCTION public.log_task_activity();

CREATE OR REPLACE FUNCTION public.log_milestone_activity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid; v_biz uuid;
BEGIN
  SELECT organization_id, business_id INTO v_org, v_biz FROM public.projects WHERE id = NEW.project_id;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.project_activity_log (organization_id, business_id, project_id, milestone_id, actor_id, event_type, summary, payload)
    VALUES (v_org, v_biz, NEW.project_id, NEW.id, auth.uid(),
            'milestone_created', 'Milestone added: ' || NEW.name, '{}'::jsonb);
  ELSIF NEW.is_reached IS DISTINCT FROM OLD.is_reached AND NEW.is_reached THEN
    INSERT INTO public.project_activity_log (organization_id, business_id, project_id, milestone_id, actor_id, event_type, summary, payload)
    VALUES (v_org, v_biz, NEW.project_id, NEW.id, auth.uid(),
            'milestone_reached', 'Milestone reached: ' || NEW.name, '{}'::jsonb);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_log_milestone_activity ON public.project_milestones;
CREATE TRIGGER trg_log_milestone_activity AFTER INSERT OR UPDATE ON public.project_milestones
  FOR EACH ROW EXECUTE FUNCTION public.log_milestone_activity();

CREATE OR REPLACE FUNCTION public.log_project_update_activity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid; v_biz uuid;
BEGIN
  SELECT organization_id, business_id INTO v_org, v_biz FROM public.projects WHERE id = NEW.project_id;
  INSERT INTO public.project_activity_log (organization_id, business_id, project_id, actor_id, event_type, summary, payload)
  VALUES (v_org, v_biz, NEW.project_id, NEW.author_id,
          'project_update', 'Status update: ' || NEW.status,
          jsonb_build_object('status', NEW.status, 'progress_pct', NEW.progress_pct));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_log_project_update_activity ON public.project_updates;
CREATE TRIGGER trg_log_project_update_activity AFTER INSERT ON public.project_updates
  FOR EACH ROW EXECUTE FUNCTION public.log_project_update_activity();

CREATE OR REPLACE FUNCTION public.log_task_comment_and_notify()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t record; v_project_name text; f record;
BEGIN
  SELECT id, name, project_id, organization_id, business_id INTO t
    FROM public.project_tasks WHERE id = NEW.task_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT name INTO v_project_name FROM public.projects WHERE id = t.project_id;
  INSERT INTO public.project_activity_log (organization_id, business_id, project_id, task_id, actor_id, event_type, summary, payload)
  VALUES (t.organization_id, t.business_id, t.project_id, t.id, NEW.created_by,
          'task_comment', 'Comment on: ' || t.name,
          jsonb_build_object('preview', LEFT(NEW.content, 160)));
  IF NEW.created_by IS NOT NULL THEN
    INSERT INTO public.task_followers (task_id, user_id) VALUES (t.id, NEW.created_by) ON CONFLICT DO NOTHING;
  END IF;
  FOR f IN SELECT user_id FROM public.task_followers
           WHERE task_id = t.id AND user_id <> COALESCE(NEW.created_by, '00000000-0000-0000-0000-000000000000'::uuid)
  LOOP
    PERFORM public.create_notification(
      t.organization_id, f.user_id,
      'task_comment', 'tasks',
      'New comment on ' || COALESCE(v_project_name,'project'),
      LEFT(t.name || ': ' || NEW.content, 200),
      '/projects-app/' || t.project_id::text || '/tasks?task=' || t.id::text,
      'project_task', t.id, 0, t.business_id
    );
  END LOOP;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_log_task_comment ON public.task_comments;
CREATE TRIGGER trg_log_task_comment AFTER INSERT ON public.task_comments
  FOR EACH ROW EXECUTE FUNCTION public.log_task_comment_and_notify();

CREATE OR REPLACE FUNCTION public.sync_count_task_for_line()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_open int;
BEGIN
  IF NEW.counted_at IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.counted_at IS NOT NULL
     AND OLD.counted_qty IS NOT DISTINCT FROM NEW.counted_qty THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_open
    FROM public.wms_count_lines l
   WHERE l.session_id = NEW.session_id
     AND l.location_id = NEW.location_id
     AND l.counted_at IS NULL;

  UPDATE public.wms_tasks t
     SET state = CASE WHEN v_open = 0 THEN 'done'::public.wms_task_state
                      ELSE 'in_progress'::public.wms_task_state END,
         started_at = COALESCE(t.started_at, now()),
         completed_at = CASE WHEN v_open = 0 THEN now() ELSE NULL END,
         assignee_user_id = COALESCE(t.assignee_user_id, NEW.counted_by),
         updated_at = now()
   WHERE t.source_doc_type = 'wms_count_session'
     AND t.source_doc_id = NEW.session_id
     AND t.source_location_id = NEW.location_id
     AND t.state NOT IN ('done', 'cancelled');

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_sync_count_task_for_line ON public.wms_count_lines;
CREATE TRIGGER trg_sync_count_task_for_line
  AFTER INSERT OR UPDATE OF counted_qty, counted_at ON public.wms_count_lines
  FOR EACH ROW EXECUTE FUNCTION public.sync_count_task_for_line();

CREATE OR REPLACE FUNCTION public.close_count_tasks_on_session_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN RETURN NEW; END IF;
  IF NEW.state::text NOT IN ('posted', 'cancelled') THEN RETURN NEW; END IF;

  UPDATE public.wms_tasks
     SET state = CASE WHEN NEW.state::text = 'posted'
                      THEN 'done'::public.wms_task_state
                      ELSE 'cancelled'::public.wms_task_state END,
         completed_at = now(),
         cancel_reason = CASE WHEN NEW.state::text = 'cancelled'
                              THEN 'count session cancelled' ELSE cancel_reason END,
         updated_at = now()
   WHERE source_doc_type = 'wms_count_session'
     AND source_doc_id = NEW.id
     AND state NOT IN ('done', 'cancelled');

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_close_count_tasks_on_session_state ON public.wms_count_sessions;
CREATE TRIGGER trg_close_count_tasks_on_session_state
  AFTER UPDATE OF state ON public.wms_count_sessions
  FOR EACH ROW EXECUTE FUNCTION public.close_count_tasks_on_session_state();

CREATE OR REPLACE FUNCTION public.get_count_task_target(p_task_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_task record;
  v_session record;
  v_open int;
BEGIN
  SELECT id, business_id, task_type, source_doc_type, source_doc_id, source_location_id
    INTO v_task FROM public.wms_tasks WHERE id = p_task_id;
  IF v_task.id IS NULL THEN RAISE EXCEPTION 'task % not found', p_task_id; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_task.business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF v_task.task_type::text <> 'count' OR v_task.source_doc_type <> 'wms_count_session' THEN
    RETURN jsonb_build_object('session_id', NULL);
  END IF;

  SELECT id, code, state, is_blind INTO v_session
    FROM public.wms_count_sessions WHERE id = v_task.source_doc_id;

  SELECT count(*) INTO v_open
    FROM public.wms_count_lines l
   WHERE l.session_id = v_task.source_doc_id
     AND l.location_id = v_task.source_location_id
     AND l.counted_at IS NULL;

  RETURN jsonb_build_object(
    'session_id', v_session.id,
    'session_code', v_session.code,
    'session_state', v_session.state,
    'blind', v_session.is_blind,
    'location_id', v_task.source_location_id,
    'open_lines', v_open
  );
END; $$;

GRANT EXECUTE ON FUNCTION public.get_count_task_target(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.sync_count_task_for_line() IS
  'ADR 0106 - count tasks close when their bin is fully counted.';
COMMENT ON FUNCTION public.close_count_tasks_on_session_state() IS
  'ADR 0106 - posting or cancelling a session leaves no open count tasks.';
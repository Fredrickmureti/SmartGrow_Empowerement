-- WMS Labour Phase F — operator self-service shift clock + automatic idle/indirect capture

-- Helpers -------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._wms_labour_close_open(p_operator_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.wms_labour_time_entries
     SET ended_at = now(), updated_at = now()
   WHERE operator_id = p_operator_id
     AND ended_at IS NULL;
END $$;

CREATE OR REPLACE FUNCTION public._wms_labour_open(
  p_operator_id uuid,
  p_category text,
  p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  op public.wms_operators;
  v_id uuid;
BEGIN
  SELECT * INTO op FROM public.wms_operators WHERE id = p_operator_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operator % not found', p_operator_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM public._wms_labour_close_open(p_operator_id);

  INSERT INTO public.wms_labour_time_entries
    (organization_id, business_id, warehouse_id, operator_id, user_id,
     category, started_at, notes, created_by)
  VALUES
    (op.organization_id, op.business_id, op.warehouse_id, op.id, op.user_id,
     p_category, now(), p_notes, auth.uid())
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

-- Self-service operator lookup ----------------------------------------------

CREATE OR REPLACE FUNCTION public.wms_my_operator(_warehouse_id uuid)
RETURNS public.wms_operators
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT o.* FROM public.wms_operators o
   WHERE o.warehouse_id = _warehouse_id
     AND o.user_id = auth.uid()
     AND o.is_active
   LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.wms_my_operator(uuid) TO authenticated;

-- Shift clock ---------------------------------------------------------------
-- Status transitions are the ONLY writer of non-task labour time. An
-- operator on shift accrues `idle` until a task moves them to `executing`;
-- a break accrues `break`. Every transition closes whatever was open, so
-- overlapping entries are structurally impossible.

CREATE OR REPLACE FUNCTION public.wms_operator_clock(
  _warehouse_id uuid,
  _status text,
  _notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  op public.wms_operators;
  v_open integer;
BEGIN
  IF _status NOT IN ('off_shift','on_shift','break') THEN
    RAISE EXCEPTION 'operators may only clock off_shift, on_shift or break (got %)', _status
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO op FROM public.wms_operators
   WHERE warehouse_id = _warehouse_id AND user_id = auth.uid() AND is_active
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'you are not enrolled as an operator in this warehouse'
      USING ERRCODE = 'P0002';
  END IF;

  IF _status IN ('off_shift','break') THEN
    SELECT COUNT(*) INTO v_open FROM public.wms_tasks
     WHERE assignee_user_id = auth.uid()
       AND warehouse_id = _warehouse_id
       AND state::text IN ('claimed','in_progress','resumed');
    IF v_open > 0 THEN
      RAISE EXCEPTION 'finish, pause or release your % open task(s) first', v_open
        USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE public.wms_operators
     SET status = _status, status_changed_at = now(), updated_at = now()
   WHERE id = op.id;

  IF _status = 'on_shift' THEN
    PERFORM public._wms_labour_open(op.id, 'idle', _notes);
  ELSIF _status = 'break' THEN
    PERFORM public._wms_labour_open(op.id, 'break', _notes);
  ELSE
    PERFORM public._wms_labour_close_open(op.id);
  END IF;

  RETURN jsonb_build_object('operator_id', op.id, 'status', _status);
END $$;

GRANT EXECUTE ON FUNCTION public.wms_operator_clock(uuid, text, text) TO authenticated;

-- Manual indirect time ------------------------------------------------------

CREATE OR REPLACE FUNCTION public.wms_log_labour_entry(
  _warehouse_id uuid,
  _category text,
  _seconds numeric,
  _notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  op public.wms_operators;
  v_id uuid;
BEGIN
  IF _category NOT IN ('indirect','travel','training','meeting','maintenance') THEN
    RAISE EXCEPTION 'invalid indirect category %', _category USING ERRCODE = '22023';
  END IF;
  IF _seconds IS NULL OR _seconds <= 0 OR _seconds > 43200 THEN
    RAISE EXCEPTION 'duration must be between 1 second and 12 hours' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO op FROM public.wms_operators
   WHERE warehouse_id = _warehouse_id AND user_id = auth.uid() AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'you are not enrolled as an operator in this warehouse'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.wms_labour_time_entries
    (organization_id, business_id, warehouse_id, operator_id, user_id,
     category, started_at, ended_at, notes, created_by)
  VALUES
    (op.organization_id, op.business_id, op.warehouse_id, op.id, op.user_id,
     _category, now() - make_interval(secs => _seconds::double precision), now(),
     _notes, auth.uid())
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

GRANT EXECUTE ON FUNCTION public.wms_log_labour_entry(uuid, text, numeric, text) TO authenticated;

-- Task activity keeps operator state and idle time honest --------------------

CREATE OR REPLACE FUNCTION public._wms_operator_activity_sync()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  op public.wms_operators;
  v_open integer;
  v_user uuid;
BEGIN
  v_user := COALESCE(NEW.assignee_user_id, OLD.assignee_user_id);
  IF v_user IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO op FROM public.wms_operators
   WHERE warehouse_id = NEW.warehouse_id AND user_id = v_user AND is_active;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COUNT(*) INTO v_open FROM public.wms_tasks
   WHERE assignee_user_id = v_user
     AND warehouse_id = NEW.warehouse_id
     AND state::text IN ('claimed','in_progress','resumed');

  IF v_open > 0 THEN
    IF op.status <> 'executing' THEN
      UPDATE public.wms_operators
         SET status = 'executing', status_changed_at = now(), updated_at = now()
       WHERE id = op.id;
      PERFORM public._wms_labour_close_open(op.id);
    END IF;
  ELSIF op.status = 'executing' THEN
    UPDATE public.wms_operators
       SET status = 'on_shift', status_changed_at = now(), updated_at = now()
     WHERE id = op.id;
    PERFORM public._wms_labour_open(op.id, 'idle', NULL);
  END IF;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_wms_operator_activity_sync ON public.wms_tasks;
CREATE TRIGGER trg_wms_operator_activity_sync
  AFTER UPDATE OF state ON public.wms_tasks
  FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION public._wms_operator_activity_sync();

-- Self-service performance read ---------------------------------------------

CREATE OR REPLACE FUNCTION public.wms_my_performance(
  _warehouse_id uuid,
  _days integer DEFAULT 1
) RETURNS TABLE (
  day date,
  tasks_completed bigint,
  earned_seconds numeric,
  direct_seconds numeric,
  indirect_seconds numeric,
  idle_seconds numeric,
  true_utilisation numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT v.day, v.tasks_completed, v.earned_seconds, v.direct_seconds,
         v.indirect_seconds, v.idle_seconds, v.true_utilisation
    FROM public.wms_operator_utilisation_view v
   WHERE v.warehouse_id = _warehouse_id
     AND v.user_id = auth.uid()
     AND v.day >= (now() AT TIME ZONE 'UTC')::date - GREATEST(COALESCE(_days,1),1) + 1
   ORDER BY v.day DESC;
$$;

GRANT EXECUTE ON FUNCTION public.wms_my_performance(uuid, integer) TO authenticated;
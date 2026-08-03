-- WMS Labour Phase B/C/E — dimensioned standards, eligibility-aware assignment, indirect time

ALTER TABLE public.wms_task_standards
  ADD COLUMN IF NOT EXISTS warehouse_id uuid REFERENCES public.warehouses(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS zone_id uuid REFERENCES public.stock_locations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS product_category_id uuid REFERENCES public.product_categories(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS equipment_class text,
  ADD COLUMN IF NOT EXISTS setup_seconds numeric NOT NULL DEFAULT 0 CHECK (setup_seconds >= 0),
  ADD COLUMN IF NOT EXISTS travel_seconds_per_metre numeric NOT NULL DEFAULT 0 CHECK (travel_seconds_per_metre >= 0);

CREATE INDEX IF NOT EXISTS wms_task_standards_resolve_idx
  ON public.wms_task_standards (business_id, task_type, is_active);

CREATE OR REPLACE FUNCTION public.wms_resolve_labour_standard(
  _business_id uuid,
  _task_type public.wms_task_type,
  _warehouse_id uuid DEFAULT NULL,
  _zone_id uuid DEFAULT NULL,
  _product_category_id uuid DEFAULT NULL,
  _equipment_class text DEFAULT NULL,
  _uom text DEFAULT NULL
) RETURNS public.wms_task_standards
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.*
    FROM public.wms_task_standards s
   WHERE s.business_id = _business_id
     AND s.task_type = _task_type
     AND s.is_active
     AND (s.warehouse_id IS NULL OR s.warehouse_id = _warehouse_id)
     AND (s.zone_id IS NULL OR s.zone_id = _zone_id)
     AND (s.product_category_id IS NULL OR s.product_category_id = _product_category_id)
     AND (s.equipment_class IS NULL OR s.equipment_class = _equipment_class)
     AND (_uom IS NULL OR s.uom = _uom OR s.uom = 'unit')
   ORDER BY
     (s.zone_id IS NOT NULL)::int * 8
   + (s.product_category_id IS NOT NULL)::int * 4
   + (s.equipment_class IS NOT NULL)::int * 2
   + (s.warehouse_id IS NOT NULL)::int DESC,
     (s.uom = COALESCE(_uom, s.uom)) DESC
   LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.wms_resolve_labour_standard(uuid, public.wms_task_type, uuid, uuid, uuid, text, text) TO authenticated;

-- Earned-seconds trigger now uses the resolver.
CREATE OR REPLACE FUNCTION public._wms_stamp_labour_metrics()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  std public.wms_task_standards;
  v_qty numeric;
  v_cat uuid;
  v_dist numeric;
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('role', true) <> 'service_role'
     AND (NEW.earned_seconds IS DISTINCT FROM OLD.earned_seconds
          OR NEW.actual_seconds IS DISTINCT FROM OLD.actual_seconds)
     AND NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'wms_tasks.earned_seconds / actual_seconds are managed by the labour trigger';
  END IF;

  IF NEW.state = 'done' AND (OLD.state IS DISTINCT FROM 'done') THEN
    IF NEW.completed_at IS NULL THEN NEW.completed_at := now(); END IF;
    IF NEW.started_at IS NOT NULL THEN
      NEW.actual_seconds := GREATEST(0, EXTRACT(EPOCH FROM (NEW.completed_at - NEW.started_at)));
    ELSE
      NEW.actual_seconds := 0;
    END IF;

    v_qty := COALESCE(NEW.quantity, 1);

    IF NEW.product_id IS NOT NULL THEN
      SELECT category_id INTO v_cat FROM public.products WHERE id = NEW.product_id;
    END IF;

    v_dist := NULLIF(NEW.payload->>'travel_metres','')::numeric;

    std := public.wms_resolve_labour_standard(
      NEW.business_id, NEW.task_type, NEW.warehouse_id, NEW.zone_id, v_cat,
      NULLIF(NEW.payload->>'equipment_class',''), NULL);

    IF std.id IS NULL THEN
      NEW.earned_seconds := 0;
    ELSE
      NEW.earned_seconds :=
          COALESCE(std.setup_seconds, 0)
        + COALESCE(std.seconds_per_uom, 0) * v_qty
        + COALESCE(std.travel_seconds_per_metre, 0) * COALESCE(v_dist, 0);
    END IF;
  END IF;

  RETURN NEW;
END $$;

-- Eligibility-aware claim ---------------------------------------------------

CREATE OR REPLACE FUNCTION public.wms_claim_next_task(
  _warehouse_id uuid,
  _task_types public.wms_task_type[] DEFAULT NULL,
  _zone_id uuid DEFAULT NULL,
  _lease_seconds integer DEFAULT 300
) RETURNS public.wms_tasks
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t public.wms_tasks;
  op public.wms_operators;
  v_open integer;
BEGIN
  SELECT * INTO op FROM public.wms_operators
   WHERE warehouse_id = _warehouse_id AND user_id = auth.uid() AND is_active;

  IF op.id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_open FROM public.wms_tasks
     WHERE assignee_user_id = auth.uid()
       AND warehouse_id = _warehouse_id
       AND state::text IN ('claimed','in_progress','paused','resumed');
    IF v_open >= op.max_concurrent_tasks THEN
      RAISE EXCEPTION 'operator workload limit reached (% concurrent tasks)', op.max_concurrent_tasks
        USING ERRCODE = '22023';
    END IF;
  ELSIF public.wms_operator_eligibility_enforced(_warehouse_id) THEN
    RAISE EXCEPTION 'no active warehouse operator profile for this user'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO t
  FROM public.wms_tasks
  WHERE warehouse_id = _warehouse_id
    AND state IN ('pending','available')
    AND (_task_types IS NULL OR task_type = ANY(_task_types))
    AND (_zone_id IS NULL OR zone_id = _zone_id OR zone_id IS NULL)
    AND (expires_at IS NULL OR expires_at > now())
    AND public.wms_operator_can_do_task(auth.uid(), id)
  ORDER BY
    (sla_at IS NOT NULL AND sla_at < now()) DESC,
    sla_at ASC NULLS LAST,
    priority DESC,
    created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN RETURN NULL; END IF;

  UPDATE public.wms_tasks SET
    state = 'claimed',
    claimed_by = auth.uid(),
    claimed_at = now(),
    heartbeat_at = now(),
    expires_at = now() + make_interval(secs => _lease_seconds),
    assignee_user_id = auth.uid(),
    row_version = t.row_version + 1,
    updated_at = now()
  WHERE id = t.id
  RETURNING * INTO t;

  IF op.id IS NOT NULL THEN
    UPDATE public.wms_operators
       SET status = 'executing', status_changed_at = now()
     WHERE id = op.id AND status <> 'executing';
  END IF;

  RETURN t;
END $$;

-- Eligibility-aware assignment ----------------------------------------------

CREATE OR REPLACE FUNCTION public.assign_wms_task(
  p_task_id uuid,
  p_assignee_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_task public.wms_tasks;
BEGIN
  SELECT * INTO v_task FROM public.wms_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wms_task % not found', p_task_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM public._wms_assert_business_access(v_task.business_id);

  IF v_task.state = 'assigned' AND v_task.assignee_user_id = p_assignee_user_id THEN
    RETURN jsonb_build_object('task_id', v_task.id, 'state', v_task.state, 'noop', true);
  END IF;

  IF v_task.state NOT IN ('pending','assigned') THEN
    RAISE EXCEPTION 'cannot assign task in state %', v_task.state USING ERRCODE = '22023';
  END IF;

  IF NOT public.wms_operator_can_do_task(p_assignee_user_id, p_task_id) THEN
    RAISE EXCEPTION 'operator is not eligible for this task (skill, certification, equipment or roster)'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.wms_tasks
     SET assignee_user_id = p_assignee_user_id,
         state = 'assigned',
         updated_at = now()
   WHERE id = p_task_id;

  PERFORM public.emit_business_event(
    v_task.organization_id, v_task.business_id,
    'warehouse.task.assigned', 'wms_task', v_task.id,
    format('wms.task:%s:assigned:%s', v_task.id, p_assignee_user_id),
    jsonb_build_object('task_type', v_task.task_type,
                       'assignee_user_id', p_assignee_user_id),
    v_task.branch_id, v_task.warehouse_id
  );

  RETURN jsonb_build_object('task_id', v_task.id, 'state', 'assigned');
END $$;

-- Supervisor actions --------------------------------------------------------

CREATE OR REPLACE FUNCTION public.wms_reassign_task(
  p_task_id uuid,
  p_assignee_user_id uuid,
  p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_task public.wms_tasks;
BEGIN
  SELECT * INTO v_task FROM public.wms_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wms_task % not found', p_task_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM public._wms_assert_business_access(v_task.business_id);

  IF v_task.state::text IN ('done','completed','cancelled') THEN
    RAISE EXCEPTION 'cannot reassign task in state %', v_task.state USING ERRCODE = '22023';
  END IF;

  IF NOT public.wms_operator_can_do_task(p_assignee_user_id, p_task_id) THEN
    RAISE EXCEPTION 'operator is not eligible for this task'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.wms_tasks
     SET assignee_user_id = p_assignee_user_id,
         claimed_by = NULL,
         claimed_at = NULL,
         expires_at = NULL,
         state = 'assigned',
         row_version = v_task.row_version + 1,
         payload = payload || jsonb_build_object('reassign_reason', p_reason),
         updated_at = now()
   WHERE id = p_task_id;

  PERFORM public.emit_business_event(
    v_task.organization_id, v_task.business_id,
    'warehouse.task.assigned', 'wms_task', v_task.id,
    format('wms.task:%s:reassigned:%s:%s', v_task.id, p_assignee_user_id, v_task.row_version + 1),
    jsonb_build_object('task_type', v_task.task_type,
                       'assignee_user_id', p_assignee_user_id,
                       'reassigned', true, 'reason', p_reason),
    v_task.branch_id, v_task.warehouse_id
  );

  RETURN jsonb_build_object('task_id', v_task.id, 'state', 'assigned');
END $$;

GRANT EXECUTE ON FUNCTION public.wms_reassign_task(uuid, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.wms_set_task_priority(
  p_task_id uuid,
  p_priority integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_task public.wms_tasks;
BEGIN
  SELECT * INTO v_task FROM public.wms_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wms_task % not found', p_task_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM public._wms_assert_business_access(v_task.business_id);

  UPDATE public.wms_tasks
     SET priority = p_priority,
         row_version = v_task.row_version + 1,
         updated_at = now()
   WHERE id = p_task_id;

  RETURN jsonb_build_object('task_id', p_task_id, 'priority', p_priority);
END $$;

GRANT EXECUTE ON FUNCTION public.wms_set_task_priority(uuid, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.wms_release_task(
  p_task_id uuid,
  p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_task public.wms_tasks;
BEGIN
  SELECT * INTO v_task FROM public.wms_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wms_task % not found', p_task_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM public._wms_assert_business_access(v_task.business_id);

  IF v_task.state::text NOT IN ('assigned','claimed','in_progress','paused','resumed') THEN
    RAISE EXCEPTION 'cannot release task in state %', v_task.state USING ERRCODE = '22023';
  END IF;

  UPDATE public.wms_tasks
     SET state = 'available',
         assignee_user_id = NULL,
         claimed_by = NULL,
         claimed_at = NULL,
         expires_at = NULL,
         row_version = v_task.row_version + 1,
         payload = payload || jsonb_build_object('release_reason', p_reason),
         updated_at = now()
   WHERE id = p_task_id;

  RETURN jsonb_build_object('task_id', p_task_id, 'state', 'available');
END $$;

GRANT EXECUTE ON FUNCTION public.wms_release_task(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.wms_set_operator_status(
  p_operator_id uuid,
  p_status text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  op public.wms_operators;
BEGIN
  IF p_status NOT IN ('off_shift','on_shift','break','executing') THEN
    RAISE EXCEPTION 'invalid operator status %', p_status USING ERRCODE = '22023';
  END IF;

  SELECT * INTO op FROM public.wms_operators WHERE id = p_operator_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operator % not found', p_operator_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM public._wms_assert_business_access(op.business_id);

  UPDATE public.wms_operators
     SET status = p_status, status_changed_at = now()
   WHERE id = p_operator_id;

  RETURN jsonb_build_object('operator_id', p_operator_id, 'status', p_status);
END $$;

GRANT EXECUTE ON FUNCTION public.wms_set_operator_status(uuid, text) TO authenticated;

-- Indirect / idle / travel labour -------------------------------------------

CREATE TABLE IF NOT EXISTS public.wms_labour_time_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id     uuid NOT NULL,
  warehouse_id    uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  operator_id     uuid REFERENCES public.wms_operators(id) ON DELETE SET NULL,
  user_id         uuid,
  category        text NOT NULL CHECK (category IN ('indirect','idle','travel','break','training','meeting','maintenance')),
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  seconds         numeric GENERATED ALWAYS AS (
                    CASE WHEN ended_at IS NULL THEN NULL
                         ELSE GREATEST(0, EXTRACT(EPOCH FROM (ended_at - started_at))) END
                  ) STORED,
  notes           text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wms_labour_time_entries_op_idx
  ON public.wms_labour_time_entries (warehouse_id, operator_id, started_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_labour_time_entries TO authenticated;
GRANT ALL ON public.wms_labour_time_entries TO service_role;
ALTER TABLE public.wms_labour_time_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wms_labour_time_entries_select" ON public.wms_labour_time_entries
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

CREATE POLICY "wms_labour_time_entries_write" ON public.wms_labour_time_entries
  FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'));

DROP TRIGGER IF EXISTS trg_wms_labour_time_entries_updated_at ON public.wms_labour_time_entries;
CREATE TRIGGER trg_wms_labour_time_entries_updated_at
  BEFORE UPDATE ON public.wms_labour_time_entries
  FOR EACH ROW EXECUTE FUNCTION public._touch_wms_task_standards_updated_at();

-- Utilisation view combining direct + indirect time
CREATE OR REPLACE VIEW public.wms_operator_utilisation_view
WITH (security_invoker = true) AS
WITH direct AS (
  SELECT business_id, warehouse_id, assignee_user_id AS user_id,
         (completed_at AT TIME ZONE 'UTC')::date AS day,
         COUNT(*) AS tasks_completed,
         COALESCE(SUM(earned_seconds),0) AS earned_seconds,
         COALESCE(SUM(actual_seconds),0) AS direct_seconds
    FROM public.wms_tasks
   WHERE state::text = 'done' AND completed_at IS NOT NULL AND assignee_user_id IS NOT NULL
   GROUP BY 1,2,3,4
), indirect AS (
  SELECT business_id, warehouse_id, user_id,
         (started_at AT TIME ZONE 'UTC')::date AS day,
         COALESCE(SUM(seconds) FILTER (WHERE category <> 'idle'),0) AS indirect_seconds,
         COALESCE(SUM(seconds) FILTER (WHERE category = 'idle'),0) AS idle_seconds,
         COALESCE(SUM(seconds) FILTER (WHERE category = 'travel'),0) AS travel_seconds
    FROM public.wms_labour_time_entries
   WHERE ended_at IS NOT NULL AND user_id IS NOT NULL
   GROUP BY 1,2,3,4
)
SELECT
  COALESCE(d.business_id, i.business_id)   AS business_id,
  COALESCE(d.warehouse_id, i.warehouse_id) AS warehouse_id,
  COALESCE(d.user_id, i.user_id)           AS user_id,
  COALESCE(d.day, i.day)                   AS day,
  COALESCE(d.tasks_completed, 0)           AS tasks_completed,
  COALESCE(d.earned_seconds, 0)            AS earned_seconds,
  COALESCE(d.direct_seconds, 0)            AS direct_seconds,
  COALESCE(i.indirect_seconds, 0)          AS indirect_seconds,
  COALESCE(i.idle_seconds, 0)              AS idle_seconds,
  COALESCE(i.travel_seconds, 0)            AS travel_seconds,
  CASE WHEN (COALESCE(d.direct_seconds,0) + COALESCE(i.indirect_seconds,0) + COALESCE(i.idle_seconds,0)) > 0
       THEN ROUND(COALESCE(d.earned_seconds,0)
            / (COALESCE(d.direct_seconds,0) + COALESCE(i.indirect_seconds,0) + COALESCE(i.idle_seconds,0)), 3)
       ELSE NULL END                       AS true_utilisation
FROM direct d
FULL OUTER JOIN indirect i
  ON d.business_id = i.business_id AND d.warehouse_id = i.warehouse_id
 AND d.user_id = i.user_id AND d.day = i.day;

GRANT SELECT ON public.wms_operator_utilisation_view TO authenticated, service_role;
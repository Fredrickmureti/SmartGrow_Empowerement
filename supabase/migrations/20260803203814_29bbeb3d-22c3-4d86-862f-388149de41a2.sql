CREATE TABLE IF NOT EXISTS public.wms_shift_patterns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  business_id      uuid NOT NULL,
  warehouse_id     uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  code             text NOT NULL,
  name             text NOT NULL,
  start_time       time NOT NULL,
  end_time         time NOT NULL,
  days_of_week     integer[] NOT NULL DEFAULT '{1,2,3,4,5}',
  break_minutes    integer NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  is_active        boolean NOT NULL DEFAULT true,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS wms_shift_patterns_code_uidx
  ON public.wms_shift_patterns (warehouse_id, lower(code));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_shift_patterns TO authenticated;
GRANT ALL ON public.wms_shift_patterns TO service_role;
ALTER TABLE public.wms_shift_patterns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wms_shift_patterns_select" ON public.wms_shift_patterns;
CREATE POLICY "wms_shift_patterns_select" ON public.wms_shift_patterns
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

DROP POLICY IF EXISTS "wms_shift_patterns_write" ON public.wms_shift_patterns;
CREATE POLICY "wms_shift_patterns_write" ON public.wms_shift_patterns
  FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'));

CREATE TABLE IF NOT EXISTS public.wms_operator_shifts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  business_id      uuid NOT NULL,
  warehouse_id     uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  operator_id      uuid NOT NULL REFERENCES public.wms_operators(id) ON DELETE CASCADE,
  pattern_id       uuid REFERENCES public.wms_shift_patterns(id) ON DELETE SET NULL,
  shift_date       date NOT NULL,
  start_time       time NOT NULL,
  end_time         time NOT NULL,
  break_minutes    integer NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  status           text NOT NULL DEFAULT 'planned'
                   CHECK (status IN ('planned','published','cancelled')),
  notes            text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operator_id, shift_date, start_time)
);

CREATE INDEX IF NOT EXISTS wms_operator_shifts_lookup_idx
  ON public.wms_operator_shifts (business_id, warehouse_id, shift_date, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_operator_shifts TO authenticated;
GRANT ALL ON public.wms_operator_shifts TO service_role;
ALTER TABLE public.wms_operator_shifts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wms_operator_shifts_select" ON public.wms_operator_shifts;
CREATE POLICY "wms_operator_shifts_select" ON public.wms_operator_shifts
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

DROP POLICY IF EXISTS "wms_operator_shifts_write" ON public.wms_operator_shifts;
CREATE POLICY "wms_operator_shifts_write" ON public.wms_operator_shifts
  FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'));

DROP TRIGGER IF EXISTS trg_wms_shift_patterns_updated_at ON public.wms_shift_patterns;
CREATE TRIGGER trg_wms_shift_patterns_updated_at
  BEFORE UPDATE ON public.wms_shift_patterns
  FOR EACH ROW EXECUTE FUNCTION public._touch_wms_task_standards_updated_at();

DROP TRIGGER IF EXISTS trg_wms_operator_shifts_updated_at ON public.wms_operator_shifts;
CREATE TRIGGER trg_wms_operator_shifts_updated_at
  BEFORE UPDATE ON public.wms_operator_shifts
  FOR EACH ROW EXECUTE FUNCTION public._touch_wms_task_standards_updated_at();

CREATE OR REPLACE FUNCTION public._wms_roster_seconds(_start time, _end time, _break_minutes integer)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT GREATEST(
    0,
    EXTRACT(EPOCH FROM (
      CASE WHEN _end > _start
           THEN (_end - _start)
           ELSE (_end - _start) + interval '24 hours'
      END
    )) - COALESCE(_break_minutes, 0) * 60
  );
$$;

CREATE OR REPLACE FUNCTION public.wms_labour_demand(
  _warehouse_id uuid DEFAULT NULL,
  _from date DEFAULT current_date,
  _to date DEFAULT (current_date + 6)
)
RETURNS TABLE (
  demand_date      date,
  warehouse_id     uuid,
  task_type        public.wms_task_type,
  open_tasks       bigint,
  unassigned_tasks bigint,
  overdue_tasks    bigint,
  required_seconds numeric,
  unstandardised   bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH open_work AS (
    SELECT
      t.id,
      t.warehouse_id AS wh_id,
      t.task_type AS t_type,
      t.assignee_user_id,
      t.sla_at,
      GREATEST(_from, LEAST(_to, COALESCE(t.sla_at::date, current_date))) AS demand_date,
      public.wms_resolve_labour_standard(
        t.business_id, t.task_type, t.warehouse_id, t.zone_id,
        (SELECT p.category_id FROM public.products p WHERE p.id = t.product_id),
        NULLIF(t.payload->>'equipment_class',''), NULL
      ) AS std,
      COALESCE(t.quantity, 1) AS qty,
      COALESCE(NULLIF(t.payload->>'travel_metres','')::numeric, 0) AS travel_m
    FROM public.wms_tasks t
    WHERE t.state::text IN ('pending','available','claimed','in_progress','paused','resumed')
      AND (_warehouse_id IS NULL OR t.warehouse_id = _warehouse_id)
      AND public.user_can_access_business(auth.uid(), t.business_id)
  )
  SELECT
    ow.demand_date,
    ow.wh_id,
    ow.t_type,
    COUNT(*)::bigint,
    COUNT(*) FILTER (WHERE ow.assignee_user_id IS NULL)::bigint,
    COUNT(*) FILTER (WHERE ow.sla_at IS NOT NULL AND ow.sla_at < now())::bigint,
    COALESCE(SUM(
      COALESCE((ow.std).setup_seconds, 0)
      + COALESCE((ow.std).seconds_per_uom, 0) * ow.qty
      + COALESCE((ow.std).travel_seconds_per_metre, 0) * ow.travel_m
    ), 0)::numeric,
    COUNT(*) FILTER (WHERE (ow.std).id IS NULL)::bigint
  FROM open_work ow
  GROUP BY ow.demand_date, ow.wh_id, ow.t_type
  ORDER BY ow.demand_date, ow.wh_id, ow.t_type;
$$;

GRANT EXECUTE ON FUNCTION public.wms_labour_demand(uuid, date, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.wms_labour_plan(
  _warehouse_id uuid DEFAULT NULL,
  _from date DEFAULT current_date,
  _to date DEFAULT (current_date + 6)
)
RETURNS TABLE (
  plan_date         date,
  warehouse_id      uuid,
  required_seconds  numeric,
  planned_seconds   numeric,
  published_seconds numeric,
  actual_seconds    numeric,
  planned_operators bigint,
  open_tasks        bigint,
  overdue_tasks     bigint,
  gap_seconds       numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH days AS (
    SELECT d::date AS plan_date FROM generate_series(_from, _to, interval '1 day') d
  ),
  whs AS (
    SELECT w.id
    FROM public.warehouses w
    WHERE (_warehouse_id IS NULL OR w.id = _warehouse_id)
      AND public.user_can_access_business(auth.uid(), w.business_id)
  ),
  grid AS (
    SELECT days.plan_date, whs.id AS warehouse_id FROM days CROSS JOIN whs
  ),
  demand AS (
    SELECT d.demand_date, d.warehouse_id AS wh_id,
           SUM(d.required_seconds) AS required_seconds,
           SUM(d.open_tasks)       AS open_tasks,
           SUM(d.overdue_tasks)    AS overdue_tasks
    FROM public.wms_labour_demand(_warehouse_id, _from, _to) d
    GROUP BY d.demand_date, d.warehouse_id
  ),
  supply AS (
    SELECT s.shift_date, s.warehouse_id AS wh_id,
           SUM(public._wms_roster_seconds(s.start_time, s.end_time, s.break_minutes)) AS planned_seconds,
           SUM(public._wms_roster_seconds(s.start_time, s.end_time, s.break_minutes))
             FILTER (WHERE s.status = 'published') AS published_seconds,
           COUNT(DISTINCT s.operator_id) AS planned_operators
    FROM public.wms_operator_shifts s
    WHERE s.shift_date BETWEEN _from AND _to
      AND s.status <> 'cancelled'
      AND (_warehouse_id IS NULL OR s.warehouse_id = _warehouse_id)
      AND public.user_can_access_business(auth.uid(), s.business_id)
    GROUP BY s.shift_date, s.warehouse_id
  ),
  actual AS (
    SELECT (e.started_at AT TIME ZONE 'UTC')::date AS day, e.warehouse_id AS wh_id,
           SUM(COALESCE(e.seconds, 0)) FILTER (WHERE e.category <> 'idle') AS actual_seconds
    FROM public.wms_labour_time_entries e
    WHERE (e.started_at AT TIME ZONE 'UTC')::date BETWEEN _from AND _to
      AND (_warehouse_id IS NULL OR e.warehouse_id = _warehouse_id)
      AND public.user_can_access_business(auth.uid(), e.business_id)
    GROUP BY 1, 2
  )
  SELECT
    g.plan_date,
    g.warehouse_id,
    COALESCE(dm.required_seconds, 0)::numeric,
    COALESCE(sp.planned_seconds, 0)::numeric,
    COALESCE(sp.published_seconds, 0)::numeric,
    COALESCE(ac.actual_seconds, 0)::numeric,
    COALESCE(sp.planned_operators, 0)::bigint,
    COALESCE(dm.open_tasks, 0)::bigint,
    COALESCE(dm.overdue_tasks, 0)::bigint,
    (COALESCE(dm.required_seconds, 0) - COALESCE(sp.planned_seconds, 0))::numeric
  FROM grid g
  LEFT JOIN demand dm ON dm.demand_date = g.plan_date AND dm.wh_id = g.warehouse_id
  LEFT JOIN supply sp ON sp.shift_date  = g.plan_date AND sp.wh_id = g.warehouse_id
  LEFT JOIN actual ac ON ac.day         = g.plan_date AND ac.wh_id = g.warehouse_id
  ORDER BY g.plan_date, g.warehouse_id;
$$;

GRANT EXECUTE ON FUNCTION public.wms_labour_plan(uuid, date, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.wms_apply_roster_pattern(
  _pattern_id uuid,
  _operator_ids uuid[],
  _from date,
  _to date
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  p public.wms_shift_patterns;
  v_created integer := 0;
BEGIN
  SELECT * INTO p FROM public.wms_shift_patterns WHERE id = _pattern_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift pattern not found' USING ERRCODE = '22023';
  END IF;

  IF NOT public.user_has_module_permission(auth.uid(), p.business_id, 'inventory', 'write') THEN
    RAISE EXCEPTION 'not authorised to plan labour for this warehouse' USING ERRCODE = '42501';
  END IF;

  IF _to < _from OR (_to - _from) > 92 THEN
    RAISE EXCEPTION 'roster window must be between 1 and 92 days' USING ERRCODE = '22023';
  END IF;

  WITH days AS (
    SELECT d::date AS shift_date
    FROM generate_series(_from, _to, interval '1 day') d
    WHERE EXTRACT(ISODOW FROM d)::int = ANY (p.days_of_week)
  ),
  ops AS (
    SELECT o.id
    FROM public.wms_operators o
    WHERE o.id = ANY (COALESCE(_operator_ids, '{}'::uuid[]))
      AND o.warehouse_id = p.warehouse_id
      AND o.is_active
  ),
  ins AS (
    INSERT INTO public.wms_operator_shifts (
      organization_id, business_id, warehouse_id, operator_id, pattern_id,
      shift_date, start_time, end_time, break_minutes, status, created_by
    )
    SELECT p.organization_id, p.business_id, p.warehouse_id, ops.id, p.id,
           days.shift_date, p.start_time, p.end_time, p.break_minutes,
           'planned', auth.uid()
    FROM days CROSS JOIN ops
    ON CONFLICT (operator_id, shift_date, start_time) DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*)::int INTO v_created FROM ins;

  RETURN v_created;
END $$;

GRANT EXECUTE ON FUNCTION public.wms_apply_roster_pattern(uuid, uuid[], date, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.wms_publish_labour_plan(
  _warehouse_id uuid,
  _from date,
  _to date,
  _gap_threshold_hours numeric DEFAULT 4
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  w public.warehouses;
  v_published integer := 0;
  v_gaps jsonb := '[]'::jsonb;
  r record;
BEGIN
  SELECT * INTO w FROM public.warehouses WHERE id = _warehouse_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse not found' USING ERRCODE = '22023';
  END IF;

  IF NOT public.user_has_module_permission(auth.uid(), w.business_id, 'inventory', 'write') THEN
    RAISE EXCEPTION 'not authorised to publish a labour plan' USING ERRCODE = '42501';
  END IF;

  UPDATE public.wms_operator_shifts
     SET status = 'published', updated_at = now()
   WHERE warehouse_id = _warehouse_id
     AND shift_date BETWEEN _from AND _to
     AND status = 'planned';
  GET DIAGNOSTICS v_published = ROW_COUNT;

  FOR r IN
    SELECT * FROM public.wms_labour_plan(_warehouse_id, _from, _to) pl
     WHERE pl.gap_seconds > _gap_threshold_hours * 3600
  LOOP
    v_gaps := v_gaps || jsonb_build_object(
      'date', r.plan_date,
      'required_hours', round((r.required_seconds / 3600.0)::numeric, 2),
      'planned_hours',  round((r.planned_seconds / 3600.0)::numeric, 2),
      'gap_hours',      round((r.gap_seconds / 3600.0)::numeric, 2),
      'open_tasks',     r.open_tasks,
      'overdue_tasks',  r.overdue_tasks
    );

    PERFORM public._wms_emit_event(
      'warehouse.labour.gap_detected',
      _warehouse_id,
      w.organization_id,
      w.business_id,
      _warehouse_id,
      w.branch_id,
      auth.uid(),
      jsonb_build_object(
        'plan_date',        r.plan_date,
        'required_seconds', r.required_seconds,
        'planned_seconds',  r.planned_seconds,
        'gap_seconds',      r.gap_seconds,
        'open_tasks',       r.open_tasks,
        'overdue_tasks',    r.overdue_tasks,
        'threshold_hours',  _gap_threshold_hours
      ),
      'warehouse.labour.gap_detected:' || _warehouse_id::text || ':' || r.plan_date::text,
      'labour_plan',
      _warehouse_id
    );
  END LOOP;

  PERFORM public._wms_emit_event(
    'warehouse.labour.plan_published',
    _warehouse_id,
    w.organization_id,
    w.business_id,
    _warehouse_id,
    w.branch_id,
    auth.uid(),
    jsonb_build_object(
      'from', _from, 'to', _to,
      'shifts_published', v_published,
      'gap_days', jsonb_array_length(v_gaps)
    ),
    'warehouse.labour.plan_published:' || _warehouse_id::text || ':' || _from::text || ':' || _to::text,
    'labour_plan',
    _warehouse_id
  );

  RETURN jsonb_build_object('shifts_published', v_published, 'gaps', v_gaps);
END $$;

GRANT EXECUTE ON FUNCTION public.wms_publish_labour_plan(uuid, date, date, numeric) TO authenticated;

INSERT INTO public.wms_events_catalog (topic, aggregate, transition, description, producers, consumers, idempotency_key_shape)
VALUES
  ('warehouse.labour.gap_detected', 'labour_plan', 'gap_detected',
   'Projected labour demand exceeds planned roster capacity for a day',
   ARRAY['wms_publish_labour_plan'], ARRAY['labour_board','notifications'],
   'warehouse.labour.gap_detected:{warehouse_id}:{date}'),
  ('warehouse.labour.plan_published', 'labour_plan', 'published',
   'Labour roster published for a planning window',
   ARRAY['wms_publish_labour_plan'], ARRAY['labour_board'],
   'warehouse.labour.plan_published:{warehouse_id}:{from}:{to}')
ON CONFLICT (topic) DO NOTHING;
CREATE TABLE IF NOT EXISTS public.wms_labour_targets (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL,
  business_id             uuid NOT NULL,
  warehouse_id            uuid REFERENCES public.warehouses(id) ON DELETE CASCADE,
  operator_id             uuid REFERENCES public.wms_operators(id) ON DELETE CASCADE,
  task_type               public.wms_task_type,
  target_performance_pct  numeric NOT NULL DEFAULT 100 CHECK (target_performance_pct > 0),
  target_utilisation_pct  numeric NOT NULL DEFAULT 85 CHECK (target_utilisation_pct > 0 AND target_utilisation_pct <= 100),
  incentive_threshold_pct numeric CHECK (incentive_threshold_pct IS NULL OR incentive_threshold_pct > 0),
  notes                   text,
  effective_from          date NOT NULL DEFAULT current_date,
  effective_to            date,
  is_active               boolean NOT NULL DEFAULT true,
  created_by              uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS wms_labour_targets_resolve_idx
  ON public.wms_labour_targets (business_id, is_active, effective_from);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_labour_targets TO authenticated;
GRANT ALL ON public.wms_labour_targets TO service_role;
ALTER TABLE public.wms_labour_targets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wms_labour_targets_select" ON public.wms_labour_targets;
CREATE POLICY "wms_labour_targets_select" ON public.wms_labour_targets
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

DROP POLICY IF EXISTS "wms_labour_targets_write" ON public.wms_labour_targets;
CREATE POLICY "wms_labour_targets_write" ON public.wms_labour_targets
  FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'));

DROP TRIGGER IF EXISTS trg_wms_labour_targets_updated_at ON public.wms_labour_targets;
CREATE TRIGGER trg_wms_labour_targets_updated_at
  BEFORE UPDATE ON public.wms_labour_targets
  FOR EACH ROW EXECUTE FUNCTION public._touch_wms_task_standards_updated_at();

-- Most-specific-wins resolution, mirroring wms_resolve_labour_standard.
CREATE OR REPLACE FUNCTION public.wms_resolve_labour_target(
  _business_id uuid,
  _operator_id uuid DEFAULT NULL,
  _task_type public.wms_task_type DEFAULT NULL,
  _warehouse_id uuid DEFAULT NULL,
  _on_date date DEFAULT current_date
) RETURNS public.wms_labour_targets
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.*
    FROM public.wms_labour_targets t
   WHERE t.business_id = _business_id
     AND t.is_active
     AND t.effective_from <= _on_date
     AND (t.effective_to IS NULL OR t.effective_to >= _on_date)
     AND (t.operator_id IS NULL OR t.operator_id = _operator_id)
     AND (t.task_type IS NULL OR t.task_type = _task_type)
     AND (t.warehouse_id IS NULL OR t.warehouse_id = _warehouse_id)
   ORDER BY
     (t.operator_id IS NOT NULL)::int * 4
   + (t.task_type IS NOT NULL)::int * 2
   + (t.warehouse_id IS NOT NULL)::int DESC,
     t.effective_from DESC
   LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.wms_resolve_labour_target(uuid, uuid, public.wms_task_type, uuid, date) TO authenticated;

-- Operator scorecard: actuals vs the resolved target for a window.
CREATE OR REPLACE FUNCTION public.wms_operator_scorecard(
  _warehouse_id uuid DEFAULT NULL,
  _from date DEFAULT (current_date - 6),
  _to date DEFAULT current_date
)
RETURNS TABLE (
  operator_id            uuid,
  user_id                uuid,
  warehouse_id           uuid,
  operator_code          text,
  operator_name          text,
  tasks_completed        bigint,
  earned_seconds         numeric,
  direct_seconds         numeric,
  indirect_seconds       numeric,
  idle_seconds           numeric,
  performance_pct        numeric,
  utilisation_pct        numeric,
  target_performance_pct numeric,
  target_utilisation_pct numeric,
  performance_variance   numeric,
  utilisation_variance   numeric,
  incentive_eligible     boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH ops AS (
    SELECT o.id, o.user_id, o.business_id, o.warehouse_id, o.operator_code,
           COALESCE(NULLIF(TRIM(CONCAT_WS(' ', e.first_name, e.last_name)), ''),
                    o.operator_code, 'Operator') AS op_name
      FROM public.wms_operators o
      LEFT JOIN public.employees e ON e.id = o.employee_id
     WHERE o.is_active
       AND (_warehouse_id IS NULL OR o.warehouse_id = _warehouse_id)
       AND public.user_can_access_business(auth.uid(), o.business_id)
  ), agg AS (
    SELECT u.user_id, u.warehouse_id,
           SUM(u.tasks_completed)::bigint AS tasks_completed,
           SUM(u.earned_seconds)          AS earned_seconds,
           SUM(u.direct_seconds)          AS direct_seconds,
           SUM(u.indirect_seconds)        AS indirect_seconds,
           SUM(u.idle_seconds)            AS idle_seconds
      FROM public.wms_operator_utilisation_view u
     WHERE u.day BETWEEN _from AND _to
     GROUP BY 1, 2
  )
  SELECT
    ops.id,
    ops.user_id,
    ops.warehouse_id,
    ops.operator_code,
    ops.op_name,
    COALESCE(a.tasks_completed, 0),
    COALESCE(a.earned_seconds, 0),
    COALESCE(a.direct_seconds, 0),
    COALESCE(a.indirect_seconds, 0),
    COALESCE(a.idle_seconds, 0),
    CASE WHEN COALESCE(a.direct_seconds, 0) > 0
         THEN ROUND(100 * a.earned_seconds / a.direct_seconds, 1) END,
    CASE WHEN COALESCE(a.direct_seconds, 0) + COALESCE(a.indirect_seconds, 0) + COALESCE(a.idle_seconds, 0) > 0
         THEN ROUND(100 * (COALESCE(a.direct_seconds, 0) + COALESCE(a.indirect_seconds, 0))
              / (COALESCE(a.direct_seconds, 0) + COALESCE(a.indirect_seconds, 0) + COALESCE(a.idle_seconds, 0)), 1) END,
    tgt.target_performance_pct,
    tgt.target_utilisation_pct,
    CASE WHEN COALESCE(a.direct_seconds, 0) > 0 AND tgt.target_performance_pct IS NOT NULL
         THEN ROUND(100 * a.earned_seconds / a.direct_seconds - tgt.target_performance_pct, 1) END,
    CASE WHEN COALESCE(a.direct_seconds, 0) + COALESCE(a.indirect_seconds, 0) + COALESCE(a.idle_seconds, 0) > 0
              AND tgt.target_utilisation_pct IS NOT NULL
         THEN ROUND(100 * (COALESCE(a.direct_seconds, 0) + COALESCE(a.indirect_seconds, 0))
              / (COALESCE(a.direct_seconds, 0) + COALESCE(a.indirect_seconds, 0) + COALESCE(a.idle_seconds, 0))
              - tgt.target_utilisation_pct, 1) END,
    CASE WHEN COALESCE(a.direct_seconds, 0) > 0
              AND COALESCE(tgt.incentive_threshold_pct, tgt.target_performance_pct) IS NOT NULL
         THEN (100 * a.earned_seconds / a.direct_seconds)
              >= COALESCE(tgt.incentive_threshold_pct, tgt.target_performance_pct)
         ELSE false END
  FROM ops
  LEFT JOIN agg a ON a.user_id = ops.user_id AND a.warehouse_id = ops.warehouse_id
  LEFT JOIN LATERAL public.wms_resolve_labour_target(ops.business_id, ops.id, NULL, ops.warehouse_id, _to) tgt ON true
  ORDER BY ops.op_name;
$$;

GRANT EXECUTE ON FUNCTION public.wms_operator_scorecard(uuid, date, date) TO authenticated;

-- Coaching notes reuse the existing continuous_feedback surface; no parallel HR record.
CREATE OR REPLACE FUNCTION public.wms_log_coaching_note(
  _operator_id uuid,
  _body text,
  _feedback_type text DEFAULT 'coaching'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_op public.wms_operators;
  v_id uuid;
BEGIN
  SELECT * INTO v_op FROM public.wms_operators WHERE id = _operator_id;
  IF v_op.id IS NULL THEN
    RAISE EXCEPTION 'Operator not found';
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_op.business_id)
     OR NOT public.user_has_module_permission(auth.uid(), v_op.business_id, 'inventory', 'write') THEN
    RAISE EXCEPTION 'Not authorised to coach this operator';
  END IF;
  IF v_op.employee_id IS NULL THEN
    RAISE EXCEPTION 'Operator is not linked to an employee record';
  END IF;
  IF COALESCE(TRIM(_body), '') = '' THEN
    RAISE EXCEPTION 'Coaching note cannot be empty';
  END IF;

  INSERT INTO public.continuous_feedback (
    organization_id, business_id, from_user_id, to_employee_id,
    feedback_type, body, visibility, is_anonymous
  ) VALUES (
    v_op.organization_id, v_op.business_id, auth.uid(), v_op.employee_id,
    COALESCE(NULLIF(TRIM(_feedback_type), ''), 'coaching'), TRIM(_body), 'private', false
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.wms_log_coaching_note(uuid, text, text) TO authenticated;
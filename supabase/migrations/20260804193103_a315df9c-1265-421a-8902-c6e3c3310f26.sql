CREATE OR REPLACE FUNCTION public.wms_wave_board(
  p_warehouse_id uuid,
  p_include_closed boolean DEFAULT false
)
RETURNS TABLE (
  wave_id uuid,
  wave_number text,
  state text,
  lifecycle_stage text,
  strategy text,
  strategy_name text,
  priority integer,
  carrier_id uuid,
  carrier_name text,
  dock_id uuid,
  dock_code text,
  appointment_id uuid,
  cutoff_at timestamptz,
  released_at timestamptz,
  completed_at timestamptz,
  order_count integer,
  line_count integer,
  ordered_units numeric,
  picked_units numeric,
  packed_units numeric,
  pick_progress_pct numeric,
  pack_progress_pct numeric,
  tasks_total integer,
  tasks_open integer,
  tasks_in_progress integer,
  open_exceptions integer,
  estimated_pick_minutes numeric,
  readiness_state text,
  readiness jsonb,
  risk text,
  drill_route text,
  row_version integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_business uuid;
BEGIN
  SELECT business_id INTO v_business FROM public.warehouses WHERE id = p_warehouse_id;
  IF v_business IS NULL THEN
    RAISE EXCEPTION 'warehouse % not found', p_warehouse_id USING ERRCODE='P0002';
  END IF;
  PERFORM public._wms_assert_business_access(v_business);

  RETURN QUERY
  SELECT
    w.id,
    w.wave_number,
    w.state::text,
    CASE
      WHEN w.state IN ('draft','planned') THEN 'planning'
      WHEN w.state = 'ready'              THEN 'ready'
      WHEN w.state IN ('released','picking') THEN 'picking'
      WHEN w.state IN ('picked','packing')   THEN 'packing'
      WHEN w.state = 'packed'             THEN 'dispatch'
      WHEN w.state = 'suspended'          THEN 'suspended'
      ELSE 'closed' END,
    w.strategy,
    s.name,
    w.priority,
    w.carrier_id,
    c.name,
    w.dock_id,
    d.code,
    w.appointment_id,
    w.cutoff_at,
    w.released_at,
    w.completed_at,
    COALESCE(l.order_count, 0),
    COALESCE(l.line_count, 0),
    COALESCE(l.ordered_units, 0),
    COALESCE(l.picked_units, 0),
    COALESCE(l.packed_units, 0),
    CASE WHEN COALESCE(l.ordered_units,0) > 0
         THEN ROUND(100 * l.picked_units / l.ordered_units, 1) ELSE 0 END,
    CASE WHEN COALESCE(l.ordered_units,0) > 0
         THEN ROUND(100 * l.packed_units / l.ordered_units, 1) ELSE 0 END,
    COALESCE(t.total, 0),
    COALESCE(t.open, 0),
    COALESCE(t.in_progress, 0),
    COALESCE(e.open_count, 0),
    w.estimated_pick_minutes,
    COALESCE(w.readiness->>'state', 'unknown'),
    w.readiness,
    CASE
      WHEN w.cutoff_at IS NOT NULL AND w.cutoff_at < now()
           AND w.state NOT IN ('packed','completed','cancelled','archived') THEN 'late'
      WHEN COALESCE(e.open_count,0) > 0 THEN 'exception'
      WHEN w.readiness->>'state' = 'blocked' THEN 'blocked'
      WHEN w.readiness->>'state' = 'at_risk' THEN 'at_risk'
      WHEN w.cutoff_at IS NOT NULL
           AND w.cutoff_at < now() + (COALESCE(w.estimated_pick_minutes,0) || ' minutes')::interval
        THEN 'at_risk'
      ELSE 'on_track' END,
    '/warehouse-app/picks/' || w.id::text,
    w.row_version
  FROM public.wms_pick_waves w
  LEFT JOIN public.wms_wave_strategies s ON s.id = w.strategy_id
  LEFT JOIN public.carriers c ON c.id = w.carrier_id
  LEFT JOIN public.warehouse_docks d ON d.id = w.dock_id
  LEFT JOIN LATERAL (
    SELECT count(DISTINCT wl.sales_order_id)::int AS order_count,
           count(*)::int                          AS line_count,
           COALESCE(sum(wl.quantity_ordered), 0)  AS ordered_units,
           COALESCE(sum(wl.quantity_picked), 0)   AS picked_units,
           COALESCE(sum(wl.quantity_packed), 0)   AS packed_units
    FROM public.wms_pick_wave_lines wl WHERE wl.wave_id = w.id
  ) l ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE tk.state IN ('pending','available'))::int AS open,
           count(*) FILTER (WHERE tk.state = 'in_progress')::int AS in_progress
    FROM public.wms_tasks tk WHERE tk.wave_id = w.id
  ) t ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS open_count
    FROM public.wms_exceptions ex
    WHERE ex.aggregate_type = 'wms_pick_wave' AND ex.aggregate_id = w.id
      AND ex.state NOT IN ('resolved','cancelled')
  ) e ON true
  WHERE w.warehouse_id = p_warehouse_id
    AND (p_include_closed OR w.state NOT IN ('completed','cancelled','archived'))
  ORDER BY
    (w.cutoff_at IS NULL),
    w.cutoff_at,
    w.priority DESC,
    w.created_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.wms_wave_board(uuid, boolean) TO authenticated;
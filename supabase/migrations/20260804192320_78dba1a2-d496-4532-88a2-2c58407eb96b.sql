-- The one-argument overload would make release_pick_wave(uuid) ambiguous.
DROP FUNCTION IF EXISTS public.release_pick_wave(uuid);

-- Tidy the readiness function: drop the stray declaration left in place.
CREATE OR REPLACE FUNCTION public.wms_wave_readiness(p_wave_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_wave        public.wms_pick_waves;
  v_lines       int := 0;
  v_short_lines int := 0;
  v_open_units  numeric := 0;
  v_cover_units numeric := 0;
  v_labour      record;
  v_need_sec    numeric;
  v_exceptions  int := 0;
  v_checks      jsonb := '[]'::jsonb;
  v_state       text := 'ready';
BEGIN
  SELECT * INTO v_wave FROM public.wms_pick_waves WHERE id = p_wave_id;
  IF v_wave.id IS NULL THEN
    RAISE EXCEPTION 'wave % not found', p_wave_id USING ERRCODE = 'P0002';
  END IF;
  PERFORM public._wms_assert_business_access(v_wave.business_id);

  SELECT count(*),
         count(*) FILTER (WHERE cover.available < l.qty_open),
         COALESCE(sum(l.qty_open), 0),
         COALESCE(sum(LEAST(l.qty_open, cover.available)), 0)
    INTO v_lines, v_short_lines, v_open_units, v_cover_units
  FROM (
    SELECT wl.product_id, wl.lot_number,
           GREATEST(COALESCE(wl.quantity_ordered,0) - COALESCE(wl.quantity_picked,0), 0) AS qty_open
    FROM public.wms_pick_wave_lines wl
    WHERE wl.wave_id = p_wave_id
  ) l
  JOIN LATERAL (
    SELECT COALESCE(sum(GREATEST(sq.quantity - COALESCE(sq.reserved_quantity,0), 0)), 0) AS available
    FROM public.stock_quants sq
    JOIN public.stock_locations sl ON sl.id = sq.location_id
    WHERE sq.product_id = l.product_id
      AND sl.warehouse_id = v_wave.warehouse_id
      AND sl.is_active
      AND COALESCE(sl.is_blocked, false) = false
      AND COALESCE(sl.is_receiving_staging, false) = false
      AND (l.lot_number IS NULL OR sq.lot_number = l.lot_number)
  ) cover ON true;

  v_checks := v_checks || jsonb_build_object(
    'check', 'stock',
    'state', CASE WHEN v_lines = 0 THEN 'blocked'
                  WHEN v_cover_units <= 0 THEN 'blocked'
                  WHEN v_short_lines > 0 THEN 'at_risk'
                  ELSE 'ready' END,
    'detail', jsonb_build_object(
      'lines', v_lines, 'short_lines', v_short_lines,
      'open_units', v_open_units, 'covered_units', v_cover_units,
      'coverage_pct', CASE WHEN v_open_units > 0
                           THEN ROUND(100 * v_cover_units / v_open_units, 1) ELSE 0 END),
    'reason', CASE WHEN v_lines = 0 THEN 'wave has no open lines'
                   WHEN v_cover_units <= 0 THEN 'no pickable stock for any line'
                   WHEN v_short_lines > 0 THEN v_short_lines || ' line(s) short' END
  );

  SELECT * INTO v_labour
  FROM public.wms_labour_plan(v_wave.warehouse_id, current_date, current_date) LIMIT 1;

  v_need_sec := COALESCE(v_wave.estimated_pick_minutes, v_lines * 1.5) * 60;

  v_checks := v_checks || jsonb_build_object(
    'check', 'labour',
    'state', CASE
      WHEN COALESCE(v_labour.planned_operators, 0) = 0 THEN 'at_risk'
      WHEN COALESCE(v_labour.planned_seconds, 0) - COALESCE(v_labour.required_seconds, 0) < v_need_sec THEN 'at_risk'
      ELSE 'ready' END,
    'detail', jsonb_build_object(
      'required_seconds', v_need_sec,
      'planned_seconds', COALESCE(v_labour.planned_seconds, 0),
      'committed_seconds', COALESCE(v_labour.required_seconds, 0),
      'planned_operators', COALESCE(v_labour.planned_operators, 0)),
    'reason', CASE
      WHEN COALESCE(v_labour.planned_operators, 0) = 0
        THEN 'no operators planned for today'
      WHEN COALESCE(v_labour.planned_seconds,0) - COALESCE(v_labour.required_seconds,0) < v_need_sec
        THEN 'planned labour does not cover this wave on top of committed work' END
  );

  v_checks := v_checks || jsonb_build_object(
    'check', 'departure',
    'state', CASE
      WHEN v_wave.cutoff_at IS NOT NULL AND v_wave.cutoff_at < now() THEN 'blocked'
      WHEN v_wave.dock_id IS NULL AND v_wave.appointment_id IS NULL THEN 'at_risk'
      WHEN v_wave.cutoff_at IS NOT NULL
           AND v_wave.cutoff_at < now() + (COALESCE(v_wave.estimated_pick_minutes,0) || ' minutes')::interval
        THEN 'at_risk'
      ELSE 'ready' END,
    'detail', jsonb_build_object(
      'dock_id', v_wave.dock_id, 'appointment_id', v_wave.appointment_id,
      'cutoff_at', v_wave.cutoff_at, 'carrier_id', v_wave.carrier_id),
    'reason', CASE
      WHEN v_wave.cutoff_at IS NOT NULL AND v_wave.cutoff_at < now() THEN 'cut-off has passed'
      WHEN v_wave.dock_id IS NULL AND v_wave.appointment_id IS NULL THEN 'no dock or appointment assigned'
      WHEN v_wave.cutoff_at IS NOT NULL
           AND v_wave.cutoff_at < now() + (COALESCE(v_wave.estimated_pick_minutes,0) || ' minutes')::interval
        THEN 'estimated pick time runs past the cut-off' END
  );

  SELECT count(*) INTO v_exceptions
  FROM public.wms_exceptions e
  WHERE e.aggregate_type = 'wms_pick_wave'
    AND e.aggregate_id = p_wave_id
    AND e.state NOT IN ('resolved','cancelled');

  v_checks := v_checks || jsonb_build_object(
    'check', 'exceptions',
    'state', CASE WHEN v_exceptions > 0 THEN 'at_risk' ELSE 'ready' END,
    'detail', jsonb_build_object('open', v_exceptions),
    'reason', CASE WHEN v_exceptions > 0 THEN v_exceptions || ' open exception(s)' END
  );

  SELECT CASE
    WHEN bool_or(c->>'state' = 'blocked') THEN 'blocked'
    WHEN bool_or(c->>'state' = 'at_risk') THEN 'at_risk'
    ELSE 'ready' END
  INTO v_state
  FROM jsonb_array_elements(v_checks) c;

  RETURN jsonb_build_object('wave_id', p_wave_id, 'state', v_state,
                            'checked_at', now(), 'checks', v_checks);
END;
$$;

GRANT EXECUTE ON FUNCTION public.wms_wave_readiness(uuid) TO authenticated;

-- =====================================================================
-- Phase 6 — Wave Control Tower contract. Counts, ranking and health are
-- computed here so the page never aggregates server rows in the browser.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.wms_wave_health(p_warehouse_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_business uuid;
  v_result   jsonb;
BEGIN
  SELECT business_id INTO v_business FROM public.warehouses WHERE id = p_warehouse_id;
  IF v_business IS NULL THEN
    RAISE EXCEPTION 'warehouse % not found', p_warehouse_id USING ERRCODE='P0002';
  END IF;
  PERFORM public._wms_assert_business_access(v_business);

  SELECT jsonb_build_object(
    'warehouse_id', p_warehouse_id,
    'generated_at', now(),
    'stages', jsonb_build_array(
      jsonb_build_object('stage','planning','label','Planning',
        'count', count(*) FILTER (WHERE state IN ('draft','planned')),
        'health', CASE WHEN count(*) FILTER (WHERE state IN ('draft','planned')) = 0 THEN 'idle' ELSE 'ok' END),
      jsonb_build_object('stage','ready','label','Ready to release',
        'count', count(*) FILTER (WHERE state = 'ready'),
        'health', CASE
          WHEN count(*) FILTER (WHERE state='ready' AND cutoff_at < now()) > 0 THEN 'critical'
          WHEN count(*) FILTER (WHERE state='ready') = 0 THEN 'idle' ELSE 'ok' END),
      jsonb_build_object('stage','picking','label','Picking',
        'count', count(*) FILTER (WHERE state IN ('released','picking')),
        'health', CASE
          WHEN count(*) FILTER (WHERE state IN ('released','picking') AND cutoff_at < now()) > 0 THEN 'critical'
          WHEN count(*) FILTER (WHERE state IN ('released','picking')) = 0 THEN 'idle' ELSE 'ok' END),
      jsonb_build_object('stage','packing','label','Packing',
        'count', count(*) FILTER (WHERE state IN ('picked','packing')),
        'health', CASE WHEN count(*) FILTER (WHERE state IN ('picked','packing')) = 0 THEN 'idle' ELSE 'ok' END),
      jsonb_build_object('stage','dispatch','label','Ready to dispatch',
        'count', count(*) FILTER (WHERE state = 'packed'),
        'health', CASE WHEN count(*) FILTER (WHERE state='packed') = 0 THEN 'idle' ELSE 'ok' END)
    ),
    'totals', jsonb_build_object(
      'open_waves', count(*) FILTER (WHERE state NOT IN ('completed','cancelled','archived')),
      'suspended', count(*) FILTER (WHERE state = 'suspended'),
      'blocked', count(*) FILTER (WHERE readiness->>'state' = 'blocked'
                                    AND state IN ('draft','planned','ready')),
      'at_risk', count(*) FILTER (WHERE readiness->>'state' = 'at_risk'
                                    AND state NOT IN ('completed','cancelled','archived')),
      'late', count(*) FILTER (WHERE cutoff_at < now()
                                 AND state NOT IN ('packed','completed','cancelled','archived')),
      'planned_units', COALESCE(sum(estimated_units) FILTER (
                         WHERE state NOT IN ('completed','cancelled','archived')), 0),
      'planned_hours', ROUND(COALESCE(sum(estimated_pick_minutes) FILTER (
                         WHERE state NOT IN ('completed','cancelled','archived')), 0) / 60.0, 1)
    ),
    'health', CASE
      WHEN count(*) FILTER (WHERE cutoff_at < now()
             AND state NOT IN ('packed','completed','cancelled','archived')) > 0 THEN 'critical'
      WHEN count(*) FILTER (WHERE readiness->>'state' IN ('blocked','at_risk')
             AND state NOT IN ('completed','cancelled','archived')) > 0 THEN 'warning'
      WHEN count(*) FILTER (WHERE state NOT IN ('completed','cancelled','archived')) = 0 THEN 'idle'
      ELSE 'ok' END
  ) INTO v_result
  FROM public.wms_pick_waves
  WHERE warehouse_id = p_warehouse_id
    AND created_at > now() - INTERVAL '30 days';

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.wms_wave_health(uuid) TO authenticated;

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
    '/warehouse-app/waves/' || w.id::text,
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
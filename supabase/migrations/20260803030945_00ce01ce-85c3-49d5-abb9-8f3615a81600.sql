-- Supervisor command centre read models for cycle counting (Phase C).
-- Read-only, SECURITY DEFINER so blind-session masking is decided server side.

CREATE OR REPLACE FUNCTION public.get_count_session_board(
  p_business_id uuid,
  p_warehouse_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 500
)
RETURNS TABLE(
  id uuid,
  code text,
  state text,
  strategy text,
  warehouse_id uuid,
  warehouse_name text,
  is_blind boolean,
  requires_approval boolean,
  recount_round integer,
  created_at timestamptz,
  posted_at timestamptz,
  last_activity_at timestamptz,
  line_count integer,
  counted_count integer,
  open_recounts integer,
  unexplained_variances integer,
  variance_lines integer,
  abs_variance_qty numeric,
  counters integer,
  figures_masked boolean
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT user_can_access_business(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  RETURN QUERY
  WITH s AS (
    SELECT cs.*
      FROM public.wms_count_sessions cs
     WHERE cs.business_id = p_business_id
       AND (p_warehouse_id IS NULL OR cs.warehouse_id = p_warehouse_id)
     ORDER BY cs.created_at DESC
     LIMIT GREATEST(p_limit, 1)
  ), agg AS (
    SELECT l.session_id,
           COUNT(*)::int AS line_count,
           COUNT(l.counted_at)::int AS counted_count,
           COUNT(*) FILTER (
             WHERE l.tolerance_outcome = 'recount_required'
               AND NOT EXISTS (
                 SELECT 1 FROM public.wms_count_lines r
                  WHERE r.recount_of_line_id = l.id
               )
           )::int AS open_recounts,
           COUNT(*) FILTER (
             WHERE l.counted_at IS NOT NULL
               AND COALESCE(l.variance_qty, 0) <> 0
               AND l.variance_reason IS NULL
           )::int AS unexplained_variances,
           COUNT(*) FILTER (
             WHERE l.counted_at IS NOT NULL AND COALESCE(l.variance_qty, 0) <> 0
           )::int AS variance_lines,
           COALESCE(SUM(ABS(COALESCE(l.variance_qty, 0))), 0) AS abs_variance_qty,
           COUNT(DISTINCT l.counted_by)::int AS counters,
           MAX(GREATEST(l.counted_at, l.updated_at)) AS last_activity_at
      FROM public.wms_count_lines l
     WHERE l.session_id IN (SELECT s.id FROM s)
     GROUP BY l.session_id
  )
  SELECT s.id,
         s.code,
         s.state::text,
         s.strategy::text,
         s.warehouse_id,
         w.name,
         s.is_blind,
         s.requires_approval,
         s.recount_round,
         s.created_at,
         s.posted_at,
         COALESCE(a.last_activity_at, s.updated_at),
         COALESCE(a.line_count, 0),
         COALESCE(a.counted_count, 0),
         COALESCE(a.open_recounts, 0),
         COALESCE(a.unexplained_variances, 0),
         CASE WHEN masked.v THEN NULL ELSE COALESCE(a.variance_lines, 0) END,
         CASE WHEN masked.v THEN NULL ELSE COALESCE(a.abs_variance_qty, 0) END,
         COALESCE(a.counters, 0),
         masked.v
    FROM s
    LEFT JOIN agg a ON a.session_id = s.id
    LEFT JOIN public.warehouses w ON w.id = s.warehouse_id
   CROSS JOIN LATERAL (
     SELECT (s.is_blind AND s.state IN ('draft','counting')) AS v
   ) masked
   ORDER BY s.created_at DESC;
END $function$;

REVOKE ALL ON FUNCTION public.get_count_session_board(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_count_session_board(uuid, uuid, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_count_command_center(
  p_business_id uuid,
  p_warehouse_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
  v_midnight timestamptz := date_trunc('day', now());
BEGIN
  IF NOT user_can_access_business(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  WITH scoped AS (
    SELECT cs.* FROM public.wms_count_sessions cs
     WHERE cs.business_id = p_business_id
       AND (p_warehouse_id IS NULL OR cs.warehouse_id = p_warehouse_id)
  ), lines AS (
    SELECT l.*, sc.state AS session_state, sc.code AS session_code, sc.is_blind
      FROM public.wms_count_lines l
      JOIN scoped sc ON sc.id = l.session_id
  ), headline AS (
    SELECT
      COUNT(*) FILTER (WHERE state IN ('draft','counting'))::int AS in_progress,
      COUNT(*) FILTER (WHERE state = 'review')::int AS in_review,
      COUNT(*) FILTER (WHERE state = 'review' AND requires_approval)::int AS awaiting_approval,
      COUNT(*) FILTER (WHERE state = 'posted' AND posted_at >= now() - interval '30 days')::int AS posted_30d
      FROM scoped
  ), recounts AS (
    SELECT COUNT(*)::int AS open_recounts
      FROM lines l
     WHERE l.tolerance_outcome = 'recount_required'
       AND l.session_state IN ('draft','counting','review')
       AND NOT EXISTS (SELECT 1 FROM public.wms_count_lines r WHERE r.recount_of_line_id = l.id)
  ), accuracy AS (
    SELECT
      COUNT(*)::int AS counted_lines,
      COUNT(*) FILTER (WHERE COALESCE(l.variance_qty, 0) = 0)::int AS accurate_lines
      FROM lines l
     WHERE l.counted_at >= now() - interval '30 days'
       AND l.session_state = 'posted'
  ), trend AS (
    SELECT COALESCE(jsonb_agg(t ORDER BY t.day), '[]'::jsonb) AS rows
      FROM (
        SELECT date_trunc('day', l.counted_at)::date AS day,
               COUNT(*)::int AS counted_lines,
               COUNT(*) FILTER (WHERE COALESCE(l.variance_qty, 0) = 0)::int AS accurate_lines
          FROM lines l
         WHERE l.counted_at >= now() - interval '30 days'
           AND l.session_state = 'posted'
         GROUP BY 1
      ) t
  ), overdue AS (
    SELECT COALESCE(jsonb_agg(x ORDER BY x.next_run_at), '[]'::jsonb) AS rows
      FROM (
        SELECT sch.id, sch.name, sch.cadence, sch.next_run_at, sch.warehouse_id
          FROM public.cycle_count_schedules sch
         WHERE sch.business_id = p_business_id
           AND sch.active
           AND sch.next_run_at IS NOT NULL
           AND sch.next_run_at < now()
           AND (p_warehouse_id IS NULL OR sch.warehouse_id = p_warehouse_id)
         LIMIT 50
      ) x
  ), productivity AS (
    SELECT COALESCE(jsonb_agg(x ORDER BY x.lines_counted DESC), '[]'::jsonb) AS rows
      FROM (
        SELECT l.counted_by AS user_id,
               COUNT(*)::int AS lines_counted,
               COUNT(*) FILTER (WHERE COALESCE(l.variance_qty, 0) <> 0)::int AS variance_lines,
               COUNT(*) FILTER (WHERE l.tolerance_outcome = 'recount_required')::int AS flagged_lines
          FROM lines l
         WHERE l.counted_at >= v_midnight AND l.counted_by IS NOT NULL
         GROUP BY l.counted_by
         LIMIT 50
      ) x
  ), heatmap AS (
    SELECT COALESCE(jsonb_agg(x ORDER BY x.variance_lines DESC), '[]'::jsonb) AS rows
      FROM (
        SELECT l.location_id,
               sl.code AS location_code,
               sl.name AS location_name,
               COUNT(*)::int AS counted_lines,
               COUNT(*) FILTER (WHERE COALESCE(l.variance_qty, 0) <> 0)::int AS variance_lines,
               COALESCE(SUM(ABS(COALESCE(l.variance_qty, 0))), 0) AS abs_variance_qty
          FROM lines l
          LEFT JOIN public.stock_locations sl ON sl.id = l.location_id
         WHERE l.counted_at >= now() - interval '90 days'
           AND l.session_state = 'posted'
         GROUP BY l.location_id, sl.code, sl.name
         HAVING COUNT(*) FILTER (WHERE COALESCE(l.variance_qty, 0) <> 0) > 0
         LIMIT 25
      ) x
  ), activity AS (
    SELECT COALESCE(jsonb_agg(x ORDER BY x.counted_at DESC), '[]'::jsonb) AS rows
      FROM (
        SELECT l.id,
               l.session_id,
               l.session_code,
               l.counted_at,
               l.counted_by,
               l.tolerance_outcome,
               l.recount_round,
               p.name AS product_name,
               sl.code AS location_code,
               CASE WHEN l.is_blind AND l.session_state IN ('draft','counting')
                    THEN NULL ELSE l.variance_qty END AS variance_qty
          FROM lines l
          LEFT JOIN public.products p ON p.id = l.product_id
          LEFT JOIN public.stock_locations sl ON sl.id = l.location_id
         WHERE l.counted_at IS NOT NULL
         ORDER BY l.counted_at DESC
         LIMIT 40
      ) x
  )
  SELECT jsonb_build_object(
    'in_progress', h.in_progress,
    'in_review', h.in_review,
    'awaiting_approval', h.awaiting_approval,
    'posted_30d', h.posted_30d,
    'open_recounts', r.open_recounts,
    'overdue_schedules', o.rows,
    'accuracy_counted_lines', ac.counted_lines,
    'accuracy_accurate_lines', ac.accurate_lines,
    'accuracy_trend', tr.rows,
    'operator_productivity', pr.rows,
    'bin_heatmap', hm.rows,
    'activity', av.rows,
    'generated_at', now()
  )
    INTO v_result
    FROM headline h, recounts r, accuracy ac, trend tr, overdue o,
         productivity pr, heatmap hm, activity av;

  RETURN COALESCE(v_result, '{}'::jsonb);
END $function$;

REVOKE ALL ON FUNCTION public.get_count_command_center(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_count_command_center(uuid, uuid) TO authenticated;
-- Supervisor Control Center — server-side flow health contract.
-- Health rules live in SQL so mobile, alerting and the desktop board cannot drift.

CREATE OR REPLACE FUNCTION public.wms_flow_health(
  p_business_id uuid,
  p_warehouse_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_stages jsonb;
  v_overall text;
  v_reason text;
  v_worst text;
BEGIN
  PERFORM public._wms_assert_business_access(p_business_id);

  WITH stage_def(stage, stage_order, label, drill_route) AS (
    VALUES
      ('receive',   1, 'Receive',     '/warehouse-app/receiving'),
      ('inspect',   2, 'Inspect',     '/warehouse-app/qc'),
      ('putaway',   3, 'Put-away',    '/warehouse-app/putaway'),
      ('store',     4, 'Store',       '/warehouse-app/tasks'),
      ('replenish', 5, 'Replenish',   '/warehouse-app/replenishment'),
      ('pick',      6, 'Pick',        '/warehouse-app/waves'),
      ('pack',      7, 'Pack',        '/warehouse-app/tasks'),
      ('load',      8, 'Load',        '/warehouse-app/dispatch'),
      ('dispatch',  9, 'Dispatch',    '/warehouse-app/dispatch')
  ),
  task_items AS (
    SELECT
      CASE t.task_type::text
        WHEN 'qc'        THEN 'inspect'
        WHEN 'putaway'   THEN 'putaway'
        WHEN 'move'      THEN 'store'
        WHEN 'replenish' THEN 'replenish'
        WHEN 'pick'      THEN 'pick'
        WHEN 'pack'      THEN 'pack'
        WHEN 'load'      THEN 'load'
        WHEN 'yard_move' THEN 'dispatch'
      END                                        AS stage,
      t.created_at                               AS since,
      t.sla_at                                   AS sla_at,
      (t.state::text = 'in_progress')            AS is_active,
      (t.assignee_user_id IS NULL
        AND t.claimed_by IS NULL)                AS is_unassigned,
      (t.state::text IN ('exception', 'paused'))  AS is_blocked
    FROM public.wms_tasks t
    WHERE t.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR t.warehouse_id = p_warehouse_id)
      AND t.state::text IN ('pending','available','assigned','claimed','in_progress','paused','exception')
      AND t.task_type::text <> 'count'
  ),
  receive_items AS (
    SELECT
      'receive'::text                            AS stage,
      s.created_at                               AS since,
      NULL::timestamptz                          AS sla_at,
      (s.state::text IN ('unloading','captured')) AS is_active,
      (s.supervisor_id IS NULL)                  AS is_unassigned,
      (s.state::text = 'discrepant')             AS is_blocked
    FROM public.wms_receiving_sessions s
    WHERE s.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR s.warehouse_id = p_warehouse_id)
      AND s.state::text NOT IN ('closed','cancelled','posted','completed')
  ),
  dispatch_items AS (
    SELECT
      'dispatch'::text                           AS stage,
      m.created_at                               AS since,
      m.planned_departure_at                     AS sla_at,
      (m.state::text IN ('loading','staged'))    AS is_active,
      false                                      AS is_unassigned,
      (m.state::text IN ('blocked','on_hold'))   AS is_blocked
    FROM public.wms_loading_manifests m
    WHERE m.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR m.warehouse_id = p_warehouse_id)
      AND m.dispatched_at IS NULL
      AND m.state::text NOT IN ('cancelled','dispatched')
  ),
  items AS (
    SELECT * FROM task_items WHERE stage IS NOT NULL
    UNION ALL SELECT * FROM receive_items
    UNION ALL SELECT * FROM dispatch_items
  ),
  agg AS (
    SELECT
      d.stage, d.stage_order, d.label, d.drill_route,
      COUNT(i.stage)                                                      AS backlog,
      COUNT(i.stage) FILTER (WHERE i.is_active)                           AS in_progress,
      COUNT(i.stage) FILTER (WHERE i.is_unassigned AND NOT i.is_active)   AS unassigned,
      COUNT(i.stage) FILTER (WHERE i.is_blocked)                          AS blocked,
      COALESCE(MAX(EXTRACT(epoch FROM (now() - i.since))), 0)::bigint      AS oldest_age_seconds,
      COUNT(i.stage) FILTER (
        WHERE i.sla_at IS NOT NULL AND i.sla_at >= now()
          AND i.sla_at < now() + interval '30 minutes')                   AS sla_at_risk,
      COUNT(i.stage) FILTER (WHERE i.sla_at IS NOT NULL AND i.sla_at < now()) AS sla_breached
    FROM stage_def d
    LEFT JOIN items i ON i.stage = d.stage
    GROUP BY d.stage, d.stage_order, d.label, d.drill_route
  ),
  scored AS (
    SELECT a.*,
      CASE
        WHEN a.backlog = 0 THEN 'healthy'
        WHEN a.blocked > 0 AND a.in_progress = 0 THEN 'blocked'
        WHEN a.sla_breached > 0 THEN 'critical'
        WHEN a.sla_at_risk > 0
          OR a.blocked > 0
          OR a.oldest_age_seconds > 14400
          OR (a.in_progress = 0 AND a.unassigned >= 5) THEN 'degraded'
        ELSE 'healthy'
      END AS health,
      CASE
        WHEN a.backlog = 0 THEN 0
        WHEN a.blocked > 0 AND a.in_progress = 0 THEN 4
        WHEN a.sla_breached > 0 THEN 3
        WHEN a.sla_at_risk > 0 OR a.blocked > 0 OR a.oldest_age_seconds > 14400
          OR (a.in_progress = 0 AND a.unassigned >= 5) THEN 2
        ELSE 1
      END AS rank
    FROM agg a
  )
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'stage', stage,
      'stage_order', stage_order,
      'label', label,
      'drill_route', drill_route,
      'backlog', backlog,
      'in_progress', in_progress,
      'unassigned', unassigned,
      'blocked', blocked,
      'oldest_age_seconds', oldest_age_seconds,
      'sla_at_risk', sla_at_risk,
      'sla_breached', sla_breached,
      'health', health
    ) ORDER BY stage_order), '[]'::jsonb)
  INTO v_stages
  FROM scored;

  SELECT s.health, s.label
    INTO v_overall, v_worst
  FROM jsonb_to_recordset(v_stages)
    AS s(health text, label text, backlog bigint, rank int)
  ORDER BY
    CASE s.health WHEN 'blocked' THEN 4 WHEN 'critical' THEN 3
                  WHEN 'degraded' THEN 2 ELSE 1 END DESC,
    s.backlog DESC
  LIMIT 1;

  v_overall := COALESCE(v_overall, 'healthy');

  SELECT CASE v_overall
    WHEN 'blocked'  THEN v_worst || ' is blocked with no work in progress'
    WHEN 'critical' THEN v_worst || ' has work past its deadline'
    WHEN 'degraded' THEN v_worst || ' is backing up'
    ELSE 'All stages within thresholds'
  END INTO v_reason;

  RETURN jsonb_build_object(
    'business_id', p_business_id,
    'warehouse_id', p_warehouse_id,
    'generated_at', now(),
    'overall', v_overall,
    'reason', v_reason,
    'worst_stage', v_worst,
    'stages', v_stages
  );
END $function$;

GRANT EXECUTE ON FUNCTION public.wms_flow_health(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.wms_flow_bottlenecks(
  p_business_id uuid,
  p_warehouse_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rows jsonb;
BEGIN
  PERFORM public._wms_assert_business_access(p_business_id);

  WITH open_tasks AS (
    SELECT t.*, t.task_type::text AS ttype, t.state::text AS tstate
    FROM public.wms_tasks t
    WHERE t.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR t.warehouse_id = p_warehouse_id)
      AND t.state::text IN ('pending','available','assigned','claimed','in_progress','paused','exception')
  ),
  by_type AS (
    SELECT
      ttype,
      COUNT(*)                                                        AS backlog,
      COUNT(*) FILTER (WHERE sla_at IS NOT NULL AND sla_at < now())    AS breached,
      COUNT(*) FILTER (WHERE tstate IN ('exception','paused'))         AS blocked,
      COUNT(*) FILTER (WHERE assignee_user_id IS NULL
                         AND claimed_by IS NULL)                       AS unassigned,
      COUNT(*) FILTER (WHERE tstate = 'in_progress')                   AS active,
      MAX(EXTRACT(epoch FROM (now() - created_at)))::bigint            AS oldest
    FROM open_tasks GROUP BY ttype
  ),
  reasons AS (
    SELECT 'sla_breached'::text AS reason_code,
           ttype::text AS scope,
           breached::bigint AS impact_count,
           3 AS severity,
           'Work past its deadline in ' || replace(ttype, '_', ' ') AS reason,
           '/warehouse-app/tasks' AS route
      FROM by_type WHERE breached > 0
    UNION ALL
    SELECT 'blocked_work', ttype::text, blocked::bigint, 3,
           replace(ttype, '_', ' ') || ' work is blocked or paused',
           '/warehouse-app/exceptions'
      FROM by_type WHERE blocked > 0
    UNION ALL
    SELECT 'no_operator', ttype::text, unassigned::bigint, 2,
           'No operator on ' || replace(ttype, '_', ' ') || ' work',
           '/warehouse-app/labour'
      FROM by_type WHERE unassigned > 0 AND active = 0
    UNION ALL
    SELECT 'aging_backlog', ttype::text, backlog::bigint, 2,
           replace(ttype, '_', ' ') || ' backlog aging past 2h',
           '/warehouse-app/tasks'
      FROM by_type WHERE oldest > 7200 AND backlog > 0
    UNION ALL
    SELECT 'exception', e.kind::text, COUNT(*)::bigint, 2,
           'Open exceptions: ' || replace(e.kind::text, '_', ' '),
           '/warehouse-app/exceptions'
      FROM public.wms_exceptions e
     WHERE e.business_id = p_business_id
       AND (p_warehouse_id IS NULL OR e.warehouse_id = p_warehouse_id)
       AND e.state::text IN ('open','acknowledged','investigating','escalated')
     GROUP BY e.kind
    UNION ALL
    SELECT 'dock_dwell', 'receive', COUNT(*)::bigint, 3,
           'Trailers arrived over an hour ago and still not unloaded',
           '/warehouse-app/schedule'
      FROM public.wms_dock_appointments a
     WHERE a.business_id = p_business_id
       AND (p_warehouse_id IS NULL OR a.warehouse_id = p_warehouse_id)
       AND a.state::text = 'arrived'
       AND a.arrived_at < now() - interval '1 hour'
     HAVING COUNT(*) > 0
    UNION ALL
    SELECT 'replenishment_starvation', 'replenish', COUNT(*)::bigint, 3,
           'Replenishment orders past their due time',
           '/warehouse-app/replenishment'
      FROM public.wms_replen_orders r
     WHERE r.business_id = p_business_id
       AND (p_warehouse_id IS NULL OR r.warehouse_id = p_warehouse_id)
       AND r.state::text NOT IN ('completed','cancelled')
       AND r.due_at IS NOT NULL AND r.due_at < now()
     HAVING COUNT(*) > 0
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'reason_code', reason_code,
           'scope', scope,
           'reason', reason,
           'severity', severity,
           'impact_count', impact_count,
           'route', route
         ) ORDER BY severity DESC, impact_count DESC), '[]'::jsonb)
    INTO v_rows
  FROM (SELECT * FROM reasons ORDER BY severity DESC, impact_count DESC LIMIT 25) r;

  RETURN jsonb_build_object(
    'business_id', p_business_id,
    'warehouse_id', p_warehouse_id,
    'generated_at', now(),
    'bottlenecks', v_rows
  );
END $function$;

GRANT EXECUTE ON FUNCTION public.wms_flow_bottlenecks(uuid, uuid) TO authenticated;
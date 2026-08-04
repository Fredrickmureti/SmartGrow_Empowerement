-- =====================================================================
-- ADR-0111 — Inbound Control Tower server-side contract.
-- Mirrors the proven wms_outbound_* contract. All health thresholds,
-- blocker classification and SLA rules live here so desktop, mobile and
-- alerting cannot drift.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.wms_inbound_health(
  p_business_id uuid,
  p_warehouse_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._wms_assert_business_access(p_business_id);

  RETURN (
  WITH stage_def(stage, stage_order, label, drill_route) AS (
    VALUES
      ('appointment', 1, 'Appointment', '/warehouse-app/schedule'),
      ('gate',        2, 'Gate',        '/warehouse-app/yard/gate'),
      ('yard',        3, 'Yard',        '/warehouse-app/yard'),
      ('dock',        4, 'Dock',        '/warehouse-app/schedule'),
      ('unload',      5, 'Unload',      '/warehouse-app/receiving'),
      ('capture',     6, 'Capture',     '/warehouse-app/receiving'),
      ('inspect',     7, 'Inspect',     '/warehouse-app/qc'),
      ('crossdock',   8, 'Cross-dock',  '/warehouse-app/crossdock'),
      ('putaway',     9, 'Put-away',    '/warehouse-app/putaway')
  ),
  appt_items AS (
    SELECT
      'appointment'::text                       AS stage,
      a.created_at                              AS since,
      a.window_end                              AS sla_at,
      false                                     AS is_active,
      (a.dock_id IS NULL)                       AS is_unassigned,
      false                                     AS is_blocked
    FROM public.wms_dock_appointments a
    WHERE a.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR a.warehouse_id = p_warehouse_id)
      AND a.appointment_type = 'inbound'
      AND a.state NOT IN ('cancelled','completed','departed','no_show')
      AND a.arrived_at IS NULL
      AND a.window_start >= now() - interval '3 days'
  ),
  visit_items AS (
    SELECT
      CASE
        WHEN v.docked_at IS NOT NULL THEN 'dock'
        WHEN v.yard_slot_id IS NOT NULL THEN 'yard'
        ELSE 'gate'
      END                                       AS stage,
      COALESCE(v.arrived_at, v.created_at)      AS since,
      NULL::timestamptz                         AS sla_at,
      (v.docked_at IS NOT NULL)                 AS is_active,
      (v.dock_id IS NULL)                       AS is_unassigned,
      (COALESCE(v.dwell_minutes, EXTRACT(epoch FROM (now() - COALESCE(v.arrived_at, v.created_at)))/60) > 240) AS is_blocked
    FROM public.wms_trailer_visits v
    WHERE v.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR v.warehouse_id = p_warehouse_id)
      AND v.departed_at IS NULL
      AND COALESCE(v.status,'') NOT IN ('departed','cancelled')
      AND EXISTS (
        SELECT 1 FROM public.wms_dock_appointments a
        WHERE a.id = v.appointment_id AND a.appointment_type = 'inbound'
      )
  ),
  session_items AS (
    SELECT
      CASE WHEN s.state::text IN ('open','unloading') THEN 'unload' ELSE 'capture' END AS stage,
      COALESCE(s.started_at, s.created_at)      AS since,
      NULL::timestamptz                         AS sla_at,
      (s.state::text = 'unloading')             AS is_active,
      (s.supervisor_id IS NULL)                 AS is_unassigned,
      (s.state::text = 'discrepant')            AS is_blocked
    FROM public.wms_receiving_sessions s
    WHERE s.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR s.warehouse_id = p_warehouse_id)
      AND s.state::text IN ('open','unloading','captured','discrepant')
  ),
  qc_items AS (
    SELECT
      'inspect'::text                           AS stage,
      q.created_at                              AS since,
      NULL::timestamptz                         AS sla_at,
      (q.state = 'in_progress')                 AS is_active,
      (q.inspector_id IS NULL)                  AS is_unassigned,
      (q.state = 'failed')                      AS is_blocked
    FROM public.wms_qc_inspections q
    WHERE q.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR q.warehouse_id = p_warehouse_id)
      AND q.state NOT IN ('closed','cancelled','passed','completed')
  ),
  xdock_items AS (
    SELECT
      'crossdock'::text                         AS stage,
      o.created_at                              AS since,
      o.expires_at                              AS sla_at,
      (o.state::text IN ('approved','staging'))          AS is_active,
      (o.assigned_user_id IS NULL)                       AS is_unassigned,
      (o.state::text = 'broken')                         AS is_blocked
    FROM public.wms_crossdock_opportunities o
    WHERE o.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR o.warehouse_id = p_warehouse_id)
      AND o.state::text IN ('detected','qualified','approved','staging','staged','broken')
  ),
  putaway_items AS (
    SELECT
      'putaway'::text                           AS stage,
      t.created_at                              AS since,
      t.sla_at                                  AS sla_at,
      (t.state::text = 'in_progress')           AS is_active,
      (t.assignee_user_id IS NULL AND t.claimed_by IS NULL) AS is_unassigned,
      (t.state::text IN ('exception','paused'))  AS is_blocked
    FROM public.wms_tasks t
    WHERE t.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR t.warehouse_id = p_warehouse_id)
      AND t.task_type::text = 'putaway'
      AND t.state::text IN ('pending','available','assigned','claimed','in_progress','paused','exception')
  ),
  items AS (
    SELECT * FROM appt_items
    UNION ALL SELECT * FROM visit_items
    UNION ALL SELECT * FROM session_items
    UNION ALL SELECT * FROM qc_items
    UNION ALL SELECT * FROM xdock_items
    UNION ALL SELECT * FROM putaway_items
  ),
  agg AS (
    SELECT
      d.stage, d.stage_order, d.label, d.drill_route,
      COUNT(i.stage)                                                    AS backlog,
      COUNT(i.stage) FILTER (WHERE i.is_active)                         AS in_progress,
      COUNT(i.stage) FILTER (WHERE i.is_unassigned AND NOT i.is_active) AS unassigned,
      COUNT(i.stage) FILTER (WHERE i.is_blocked)                        AS blocked,
      COALESCE(MAX(EXTRACT(epoch FROM (now() - i.since))), 0)::bigint   AS oldest_age_seconds,
      COUNT(i.stage) FILTER (
        WHERE i.sla_at IS NOT NULL AND i.sla_at >= now()
          AND i.sla_at < now() + interval '60 minutes')                 AS sla_at_risk,
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
      END AS health
    FROM agg a
  ),
  packed AS (
    SELECT
      COALESCE(jsonb_agg(jsonb_build_object(
        'stage', stage, 'stage_order', stage_order, 'label', label,
        'drill_route', drill_route, 'backlog', backlog,
        'in_progress', in_progress, 'unassigned', unassigned,
        'blocked', blocked, 'oldest_age_seconds', oldest_age_seconds,
        'sla_at_risk', sla_at_risk, 'sla_breached', sla_breached,
        'health', health
      ) ORDER BY stage_order), '[]'::jsonb) AS stages,
      (SELECT s.health FROM scored s ORDER BY
        CASE s.health WHEN 'blocked' THEN 4 WHEN 'critical' THEN 3
                      WHEN 'degraded' THEN 2 ELSE 1 END DESC,
        s.backlog DESC LIMIT 1) AS overall,
      (SELECT s.label FROM scored s ORDER BY
        CASE s.health WHEN 'blocked' THEN 4 WHEN 'critical' THEN 3
                      WHEN 'degraded' THEN 2 ELSE 1 END DESC,
        s.backlog DESC LIMIT 1) AS worst
    FROM scored
  )
  SELECT jsonb_build_object(
    'business_id', p_business_id,
    'warehouse_id', p_warehouse_id,
    'generated_at', now(),
    'overall', COALESCE(p.overall, 'healthy'),
    'worst_stage', p.worst,
    'reason', CASE COALESCE(p.overall,'healthy')
      WHEN 'blocked'  THEN p.worst || ' is blocked with no work in progress'
      WHEN 'critical' THEN p.worst || ' has work past its deadline'
      WHEN 'degraded' THEN p.worst || ' is backing up'
      ELSE 'Inbound is flowing within thresholds'
    END,
    'stages', p.stages
  ) FROM packed p);
END $function$;

-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.wms_inbound_arrivals(
  p_business_id uuid,
  p_warehouse_id uuid DEFAULT NULL::uuid,
  p_limit integer DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._wms_assert_business_access(p_business_id);

  RETURN (
  WITH appt AS (
    SELECT a.*
    FROM public.wms_dock_appointments a
    WHERE a.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR a.warehouse_id = p_warehouse_id)
      AND a.appointment_type = 'inbound'
      AND a.state NOT IN ('cancelled')
      AND a.window_start >= now() - interval '2 days'
  ),
  sess AS (
    SELECT s.*
    FROM public.wms_receiving_sessions s
    WHERE s.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR s.warehouse_id = p_warehouse_id)
      AND (
        s.state::text IN ('open','unloading','captured','discrepant')
        OR s.updated_at >= now() - interval '2 days'
      )
  ),
  base AS (
    SELECT a.id AS appointment_id, s.id AS session_id
    FROM appt a
    LEFT JOIN sess s ON s.appointment_id = a.id
    UNION
    SELECT s.appointment_id, s.id
    FROM sess s
    WHERE s.appointment_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM appt a WHERE a.id = s.appointment_id)
  ),
  rows AS (
    SELECT
      b.appointment_id,
      b.session_id,
      a.appointment_no,
      a.reference,
      a.state                                   AS appointment_state,
      a.priority,
      a.window_start,
      a.window_end,
      a.arrived_at                              AS appointment_arrived_at,
      COALESCE(a.trailer_ref, v.trailer_ref)    AS trailer_ref,
      COALESCE(a.driver_name, v.driver_name)    AS driver_name,
      c.name                                    AS carrier_name,
      v.id                                      AS visit_id,
      v.status                                  AS visit_status,
      v.arrived_at                              AS visit_arrived_at,
      v.docked_at,
      COALESCE(v.dwell_minutes,
        CASE WHEN v.arrived_at IS NOT NULL
             THEN ROUND(EXTRACT(epoch FROM (now() - v.arrived_at))/60) END)::numeric AS dwell_minutes,
      ys.code                                   AS yard_slot_code,
      COALESCE(v.dock_id, a.dock_id, s.dock_id) AS dock_id,
      dk.code                                   AS dock_code,
      s.code                                    AS session_code,
      s.state::text                             AS session_state,
      s.started_at                              AS session_started_at,
      COALESCE(pr.line_count, 0)::int           AS line_count,
      COALESCE(pr.captured_lines, 0)::int       AS captured_lines,
      COALESCE(pr.expected_qty, 0)::numeric     AS expected_qty,
      COALESCE(pr.received_qty, 0)::numeric     AS received_qty,
      COALESCE(pr.damaged_qty, 0)::numeric      AS damaged_qty,
      COALESCE(pr.short_lines, 0)::int          AS short_lines,
      COALESCE(pr.over_lines, 0)::int           AS over_lines,
      COALESCE(pr.hold_lines, 0)::int           AS hold_lines,
      COALESCE(pr.unexpected_lines, 0)::int     AS unexpected_lines,
      COALESCE(pr.damaged_lines, 0)::int        AS damaged_lines,
      (SELECT COUNT(*) FROM public.wms_qc_inspections q
         WHERE q.source_doc_id = s.id
           AND q.state NOT IN ('closed','cancelled','passed','completed'))::int AS qc_pending,
      (SELECT COUNT(*) FROM public.wms_crossdock_opportunities o
         JOIN public.wms_receiving_lines rl ON rl.id = o.receiving_line_id
         WHERE rl.session_id = s.id
           AND o.state::text IN ('detected','qualified','approved','staging','staged'))::int AS crossdock_pending,
      (SELECT COUNT(*) FROM public.wms_tasks t
         WHERE t.task_type::text = 'putaway' AND t.source_doc_id = s.id
           AND t.state::text IN ('pending','available','assigned','claimed','in_progress','paused','exception'))::int AS putaway_open,
      (SELECT COUNT(*) FROM public.wms_tasks t
         WHERE t.task_type::text = 'putaway' AND t.source_doc_id = s.id
           AND t.state::text IN ('done','completed'))::int AS putaway_done,
      (SELECT COUNT(*) FROM public.wms_exceptions e
         WHERE e.business_id = p_business_id
           AND e.state::text IN ('open','acknowledged','investigating','escalated')
           AND e.aggregate_id IN (s.id, a.id, v.id))::int AS exception_count,
      (SELECT COUNT(*) FROM public.wms_exceptions e
         WHERE e.business_id = p_business_id
           AND e.state::text IN ('open','acknowledged','investigating','escalated')
           AND e.aggregate_id IN (s.id, a.id, v.id)
           AND (e.sla_breached_at IS NOT NULL OR (e.due_by IS NOT NULL AND e.due_by < now())))::int AS exception_breached
    FROM base b
    LEFT JOIN appt a ON a.id = b.appointment_id
    LEFT JOIN sess s ON s.id = b.session_id
    LEFT JOIN public.wms_trailer_visits v
           ON v.appointment_id = a.id AND v.departed_at IS NULL
    LEFT JOIN public.carriers c ON c.id = a.carrier_id
    LEFT JOIN public.wms_yard_slots ys ON ys.id = v.yard_slot_id
    LEFT JOIN public.warehouse_docks dk ON dk.id = COALESCE(v.dock_id, a.dock_id, s.dock_id)
    LEFT JOIN public.wms_receiving_session_progress pr ON pr.session_id = s.id
  ),
  staged AS (
    SELECT r.*,
      CASE
        WHEN r.session_state IN ('posted','closed') AND r.putaway_open = 0 THEN 'available'
        WHEN r.session_state IN ('posted','closed') THEN 'putaway'
        WHEN r.qc_pending > 0 THEN 'inspect'
        WHEN r.session_state IN ('captured','discrepant') THEN 'capture'
        WHEN r.session_state IN ('open','unloading') THEN 'unload'
        WHEN r.docked_at IS NOT NULL THEN 'dock'
        WHEN r.yard_slot_code IS NOT NULL THEN 'yard'
        WHEN r.visit_arrived_at IS NOT NULL OR r.appointment_arrived_at IS NOT NULL THEN 'gate'
        ELSE 'appointment'
      END AS lifecycle_stage,
      CASE WHEN r.window_start IS NULL THEN NULL
           ELSE ROUND(EXTRACT(epoch FROM (r.window_start - now()))/60) END::int AS minutes_to_window
    FROM rows r
  ),
  risked AS (
    SELECT st.*,
      CASE
        WHEN st.lifecycle_stage = 'available' THEN 'done'
        WHEN st.exception_breached > 0
          OR (st.window_end IS NOT NULL AND st.window_end < now()
              AND st.lifecycle_stage IN ('appointment','gate')) THEN 'breached'
        WHEN st.session_state = 'discrepant'
          OR st.exception_count > 0
          OR st.hold_lines > 0 THEN 'blocked'
        WHEN COALESCE(st.dwell_minutes, 0) > 120
          OR (st.minutes_to_window IS NOT NULL AND st.minutes_to_window BETWEEN 0 AND 60)
          OR st.short_lines > 0 OR st.over_lines > 0 OR st.damaged_lines > 0 THEN 'at_risk'
        ELSE 'normal'
      END AS risk
    FROM staged st
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'arrivals', COALESCE(jsonb_agg(x ORDER BY
        CASE x.risk WHEN 'breached' THEN 1 WHEN 'blocked' THEN 2
                    WHEN 'at_risk' THEN 3 WHEN 'normal' THEN 4 ELSE 5 END,
        x.window_start NULLS LAST), '[]'::jsonb)
  )
  FROM (
    SELECT rk.*,
      CASE
        WHEN rk.session_id IS NOT NULL THEN '/warehouse-app/receiving'
        WHEN rk.visit_id IS NOT NULL THEN '/warehouse-app/yard'
        ELSE '/warehouse-app/schedule'
      END AS drill_route,
      CASE WHEN COALESCE(rk.expected_qty,0) > 0
           THEN LEAST(100, ROUND((rk.received_qty / NULLIF(rk.expected_qty,0)) * 100))::int
           ELSE NULL END AS receive_pct
    FROM risked rk
    ORDER BY
      CASE rk.risk WHEN 'breached' THEN 1 WHEN 'blocked' THEN 2
                   WHEN 'at_risk' THEN 3 WHEN 'normal' THEN 4 ELSE 5 END,
      rk.window_start NULLS LAST
    LIMIT COALESCE(p_limit, 200)
  ) x);
END $function$;

-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.wms_inbound_bottlenecks(
  p_business_id uuid,
  p_warehouse_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._wms_assert_business_access(p_business_id);

  RETURN (
  WITH b AS (
    -- Appointments past their window that never arrived.
    SELECT 'late_arrival'::text AS reason_code, 'Appointments'::text AS scope,
           'Past the booked window with no arrival'::text AS reason,
           90::int AS severity, COUNT(*)::int AS impact_count,
           '/warehouse-app/schedule'::text AS route
    FROM public.wms_dock_appointments a
    WHERE a.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR a.warehouse_id = p_warehouse_id)
      AND a.appointment_type = 'inbound'
      AND a.state NOT IN ('cancelled','completed','departed','no_show')
      AND a.arrived_at IS NULL
      AND a.window_end < now()
    HAVING COUNT(*) > 0

    UNION ALL
    -- Appointments with no dock assigned inside the next 4 hours.
    SELECT 'no_dock', 'Appointments',
           'Arriving soon with no dock assigned', 70, COUNT(*)::int,
           '/warehouse-app/schedule'
    FROM public.wms_dock_appointments a
    WHERE a.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR a.warehouse_id = p_warehouse_id)
      AND a.appointment_type = 'inbound'
      AND a.state NOT IN ('cancelled','completed','departed','no_show')
      AND a.dock_id IS NULL
      AND a.window_start BETWEEN now() - interval '1 hour' AND now() + interval '4 hours'
    HAVING COUNT(*) > 0

    UNION ALL
    -- Trailers sitting in the yard beyond two hours without a dock.
    SELECT 'yard_dwell', 'Yard',
           'Trailers waiting over 2h without a dock', 80, COUNT(*)::int,
           '/warehouse-app/yard'
    FROM public.wms_trailer_visits v
    WHERE v.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR v.warehouse_id = p_warehouse_id)
      AND v.departed_at IS NULL
      AND v.docked_at IS NULL
      AND v.arrived_at < now() - interval '2 hours'
    HAVING COUNT(*) > 0

    UNION ALL
    -- Unload sessions open for more than three hours.
    SELECT 'unload_stalled', 'Receiving',
           'Unload sessions open longer than 3h', 75, COUNT(*)::int,
           '/warehouse-app/receiving'
    FROM public.wms_receiving_sessions s
    WHERE s.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR s.warehouse_id = p_warehouse_id)
      AND s.state::text IN ('open','unloading')
      AND COALESCE(s.started_at, s.created_at) < now() - interval '3 hours'
    HAVING COUNT(*) > 0

    UNION ALL
    SELECT 'short_receipt', 'Receiving',
           'Sessions with short-received lines', 60,
           COUNT(*)::int, '/warehouse-app/receiving'
    FROM public.wms_receiving_session_progress pr
    WHERE pr.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR pr.warehouse_id = p_warehouse_id)
      AND pr.short_lines > 0
      AND pr.state::text IN ('open','unloading','captured','discrepant')
    HAVING COUNT(*) > 0

    UNION ALL
    SELECT 'over_receipt', 'Receiving',
           'Sessions with over-received lines', 55,
           COUNT(*)::int, '/warehouse-app/receiving'
    FROM public.wms_receiving_session_progress pr
    WHERE pr.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR pr.warehouse_id = p_warehouse_id)
      AND pr.over_lines > 0
      AND pr.state::text IN ('open','unloading','captured','discrepant')
    HAVING COUNT(*) > 0

    UNION ALL
    SELECT 'damaged', 'Receiving',
           'Sessions carrying damaged goods', 65,
           COUNT(*)::int, '/warehouse-app/receiving'
    FROM public.wms_receiving_session_progress pr
    WHERE pr.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR pr.warehouse_id = p_warehouse_id)
      AND pr.damaged_lines > 0
      AND pr.state::text IN ('open','unloading','captured','discrepant')
    HAVING COUNT(*) > 0

    UNION ALL
    SELECT 'qc_hold', 'Quality',
           'Inspections awaiting a decision', 70, COUNT(*)::int,
           '/warehouse-app/qc'
    FROM public.wms_qc_inspections q
    WHERE q.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR q.warehouse_id = p_warehouse_id)
      AND q.state NOT IN ('closed','cancelled','passed','completed')
    HAVING COUNT(*) > 0

    UNION ALL
    SELECT 'crossdock_expiring', 'Cross-dock',
           'Cross-dock opportunities expiring within the hour', 60,
           COUNT(*)::int, '/warehouse-app/crossdock'
    FROM public.wms_crossdock_opportunities o
    WHERE o.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR o.warehouse_id = p_warehouse_id)
      AND o.state::text IN ('detected','qualified','approved','staging')
      AND o.expires_at IS NOT NULL
      AND o.expires_at < now() + interval '1 hour'
    HAVING COUNT(*) > 0

    UNION ALL
    SELECT 'putaway_backlog', 'Put-away',
           'Put-away tasks waiting to start', 65, COUNT(*)::int,
           '/warehouse-app/putaway'
    FROM public.wms_tasks t
    WHERE t.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR t.warehouse_id = p_warehouse_id)
      AND t.task_type::text = 'putaway'
      AND t.state::text IN ('pending','available')
      AND t.created_at < now() - interval '1 hour'
    HAVING COUNT(*) > 0

    UNION ALL
    SELECT 'no_operator', 'Put-away',
           'Put-away work with nobody assigned', 55, COUNT(*)::int,
           '/warehouse-app/labour'
    FROM public.wms_tasks t
    WHERE t.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR t.warehouse_id = p_warehouse_id)
      AND t.task_type::text = 'putaway'
      AND t.state::text IN ('pending','available')
      AND t.assignee_user_id IS NULL AND t.claimed_by IS NULL
    HAVING COUNT(*) > 0

    UNION ALL
    -- Inbound-classified exceptions, classified in SQL (never in the client).
    SELECT 'exception', 'Exceptions',
           'Open inbound exceptions', 85, COUNT(*)::int,
           '/warehouse-app/exceptions'
    FROM public.wms_exceptions e
    WHERE e.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR e.warehouse_id = p_warehouse_id)
      AND e.state::text IN ('open','acknowledged','investigating','escalated')
      AND e.kind::text IN (
        'receiving_discrepancy','qc_fail','over_receipt','under_receipt',
        'wrong_supplier','wrong_asn','damaged_goods','failed_inspection',
        'asn_mismatch','missed_appointment','dock_congestion','incorrect_trailer',
        'trailer_overstay','seal_mismatch','damaged_lpn','expired_stock',
        'quarantine_violation','batch_mismatch','duplicate_serial')
    HAVING COUNT(*) > 0

    UNION ALL
    SELECT 'sla_breached', 'Exceptions',
           'Inbound exceptions past their deadline', 100, COUNT(*)::int,
           '/warehouse-app/exceptions'
    FROM public.wms_exceptions e
    WHERE e.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR e.warehouse_id = p_warehouse_id)
      AND e.state::text IN ('open','acknowledged','investigating','escalated')
      AND (e.sla_breached_at IS NOT NULL OR (e.due_by IS NOT NULL AND e.due_by < now()))
      AND e.kind::text IN (
        'receiving_discrepancy','qc_fail','over_receipt','under_receipt',
        'wrong_supplier','wrong_asn','damaged_goods','failed_inspection',
        'asn_mismatch','missed_appointment','dock_congestion','incorrect_trailer',
        'trailer_overstay','seal_mismatch','damaged_lpn')
    HAVING COUNT(*) > 0
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'reason_code', reason_code, 'scope', scope, 'reason', reason,
    'severity', severity, 'impact_count', impact_count, 'route', route
  ) ORDER BY severity DESC, impact_count DESC), '[]'::jsonb)
  FROM b);
END $function$;

-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.wms_inbound_dock_board(
  p_business_id uuid,
  p_warehouse_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._wms_assert_business_access(p_business_id);

  RETURN (
  WITH docks AS (
    SELECT d.id, d.code, d.name, d.dock_type::text AS dock_type,
      v.id AS visit_id, v.trailer_ref, v.docked_at,
      (SELECT MIN(a.window_start) FROM public.wms_dock_appointments a
        WHERE a.dock_id = d.id AND a.appointment_type = 'inbound'
          AND a.state NOT IN ('cancelled','completed','departed','no_show')
          AND a.window_start >= now()) AS next_window_at,
      (SELECT COUNT(*) FROM public.wms_receiving_sessions s
        WHERE s.dock_id = d.id
          AND s.state::text IN ('open','unloading','captured','discrepant'))::int AS open_sessions
    FROM public.warehouse_docks d
    LEFT JOIN public.wms_trailer_visits v
      ON v.dock_id = d.id AND v.departed_at IS NULL AND v.docked_at IS NOT NULL
    WHERE d.business_id = p_business_id
      AND d.is_active
      AND (p_warehouse_id IS NULL OR d.warehouse_id = p_warehouse_id)
      AND (d.dock_type::text <> 'outbound')
  ),
  waiting AS (
    SELECT v.id AS visit_id, v.trailer_ref, v.status, v.arrived_at,
      ROUND(EXTRACT(epoch FROM (now() - v.arrived_at))/60)::int AS waiting_minutes,
      v.yard_slot_id
    FROM public.wms_trailer_visits v
    WHERE v.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR v.warehouse_id = p_warehouse_id)
      AND v.departed_at IS NULL
      AND v.docked_at IS NULL
      AND v.arrived_at IS NOT NULL
  ),
  slots AS (
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE COALESCE(s.status,'free') IN ('free','available','empty'))::int AS free
    FROM public.wms_yard_slots s
    WHERE s.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR s.warehouse_id = p_warehouse_id)
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'docks', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'dock_id', id, 'code', code, 'name', name, 'dock_type', dock_type,
        'open_sessions', open_sessions, 'visit_id', visit_id,
        'trailer_ref', trailer_ref, 'docked_at', docked_at,
        'next_window_at', next_window_at,
        'occupied', visit_id IS NOT NULL
      ) ORDER BY code), '[]'::jsonb) FROM docks),
    'waiting_trailers', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'visit_id', visit_id, 'trailer_ref', trailer_ref, 'status', status,
        'arrived_at', arrived_at, 'waiting_minutes', waiting_minutes,
        'yard_slot_id', yard_slot_id
      ) ORDER BY arrived_at), '[]'::jsonb) FROM waiting),
    'yard_slots', (SELECT jsonb_build_object('total', total, 'free', free) FROM slots)
  ));
END $function$;

GRANT EXECUTE ON FUNCTION public.wms_inbound_health(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wms_inbound_arrivals(uuid, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wms_inbound_bottlenecks(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wms_inbound_dock_board(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wms_inbound_health(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.wms_inbound_arrivals(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.wms_inbound_bottlenecks(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.wms_inbound_dock_board(uuid, uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.wms_outbound_shipments(
  p_business_id uuid,
  p_warehouse_id uuid DEFAULT NULL,
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
  WITH waves AS (
    SELECT w.*
    FROM public.wms_pick_waves w
    WHERE w.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR w.warehouse_id = p_warehouse_id)
      AND w.state::text NOT IN ('cancelled')
      AND (w.completed_at IS NULL OR w.completed_at > now() - interval '24 hours')
  ),
  lines AS (
    SELECT l.wave_id,
      COUNT(*)                                  AS line_count,
      COALESCE(SUM(l.quantity_ordered), 0)      AS qty_ordered,
      COALESCE(SUM(l.quantity_picked), 0)       AS qty_picked,
      COALESCE(SUM(l.quantity_packed), 0)       AS qty_packed,
      COUNT(*) FILTER (
        WHERE COALESCE(l.quantity_picked,0) < COALESCE(l.quantity_ordered,0)) AS short_lines
    FROM public.wms_pick_wave_lines l
    WHERE l.business_id = p_business_id
    GROUP BY l.wave_id
  ),
  cartons AS (
    SELECT c.wave_id,
      COUNT(*)                                          AS carton_count,
      COUNT(*) FILTER (WHERE c.sealed_at IS NOT NULL)   AS carton_sealed,
      COUNT(*) FILTER (WHERE c.manifest_id IS NOT NULL) AS carton_manifested,
      MIN(c.manifest_id::text)                          AS any_manifest_id
    FROM public.wms_pack_cartons c
    WHERE c.business_id = p_business_id
    GROUP BY c.wave_id
  ),
  loaded AS (
    SELECT c.wave_id, COUNT(*) AS carton_loaded
    FROM public.wms_pack_cartons c
    JOIN public.wms_manifest_cartons mc ON mc.carton_id = c.id AND mc.loaded_at IS NOT NULL
    WHERE c.business_id = p_business_id
    GROUP BY c.wave_id
  ),
  wave_tasks AS (
    SELECT t.source_doc_id AS wave_id,
      COUNT(*) FILTER (WHERE t.state::text IN ('exception','paused')) AS blocked_tasks,
      COUNT(*) FILTER (WHERE t.state::text NOT IN ('completed','cancelled')) AS open_tasks,
      COUNT(*) FILTER (WHERE t.assignee_user_id IS NULL AND t.claimed_by IS NULL
        AND t.state::text NOT IN ('completed','cancelled')) AS unassigned_tasks,
      MIN(t.sla_at) FILTER (WHERE t.state::text NOT IN ('completed','cancelled')) AS next_sla_at
    FROM public.wms_tasks t
    WHERE t.business_id = p_business_id
      AND t.source_doc_type = 'wave'
    GROUP BY t.source_doc_id
  ),
  base AS (
    SELECT
      w.id                                    AS wave_id,
      w.wave_number                           AS wave_number,
      w.state::text                           AS wave_state,
      w.created_at                            AS created_at,
      w.released_at                           AS released_at,
      COALESCE(ln.line_count, 0)              AS line_count,
      COALESCE(ln.qty_ordered, 0)             AS qty_ordered,
      COALESCE(ln.qty_picked, 0)              AS qty_picked,
      COALESCE(ln.qty_packed, 0)              AS qty_packed,
      COALESCE(ln.short_lines, 0)             AS short_lines,
      COALESCE(ct.carton_count, 0)            AS carton_count,
      COALESCE(ct.carton_sealed, 0)           AS carton_sealed,
      COALESCE(ct.carton_manifested, 0)       AS carton_manifested,
      COALESCE(ld.carton_loaded, 0)           AS carton_loaded,
      COALESCE(wt.blocked_tasks, 0)           AS blocked_tasks,
      COALESCE(wt.open_tasks, 0)              AS open_tasks,
      COALESCE(wt.unassigned_tasks, 0)        AS unassigned_tasks,
      wt.next_sla_at                          AS task_sla_at,
      ct.any_manifest_id::uuid                AS manifest_id
    FROM waves w
    LEFT JOIN lines ln  ON ln.wave_id = w.id
    LEFT JOIN cartons ct ON ct.wave_id = w.id
    LEFT JOIN loaded ld  ON ld.wave_id = w.id
    LEFT JOIN wave_tasks wt ON wt.wave_id = w.id
  ),
  orphan_manifests AS (
    SELECT
      NULL::uuid AS wave_id, NULL::text AS wave_number, NULL::text AS wave_state,
      m.created_at, NULL::timestamptz AS released_at,
      0::bigint, 0::numeric, 0::numeric, 0::numeric, 0::bigint,
      (SELECT COUNT(*) FROM public.wms_manifest_cartons mc WHERE mc.manifest_id = m.id)::bigint,
      (SELECT COUNT(*) FROM public.wms_manifest_cartons mc WHERE mc.manifest_id = m.id)::bigint,
      (SELECT COUNT(*) FROM public.wms_manifest_cartons mc WHERE mc.manifest_id = m.id)::bigint,
      (SELECT COUNT(*) FROM public.wms_manifest_cartons mc WHERE mc.manifest_id = m.id AND mc.loaded_at IS NOT NULL)::bigint,
      0::bigint, 0::bigint, 0::bigint, NULL::timestamptz,
      m.id
    FROM public.wms_loading_manifests m
    WHERE m.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR m.warehouse_id = p_warehouse_id)
      AND m.state::text NOT IN ('cancelled')
      AND (m.dispatched_at IS NULL OR m.dispatched_at > now() - interval '24 hours')
      AND NOT EXISTS (
        SELECT 1 FROM public.wms_pack_cartons c
        WHERE c.manifest_id = m.id AND c.wave_id IS NOT NULL
      )
  ),
  all_rows AS (
    SELECT * FROM base
    UNION ALL SELECT * FROM orphan_manifests
  ),
  enriched AS (
    SELECT
      r.*,
      m.code                     AS manifest_code,
      m.state::text              AS manifest_state,
      m.planned_departure_at     AS planned_departure_at,
      m.dispatched_at            AS dispatched_at,
      m.dock_id                  AS dock_id,
      d.code                     AS dock_code,
      m.trailer_visit_id         AS trailer_visit_id,
      tv.trailer_ref             AS trailer_ref,
      tv.status::text            AS trailer_status,
      EXISTS (SELECT 1 FROM public.wms_dispatch_proofs p WHERE p.manifest_id = m.id) AS has_proof,
      (SELECT COUNT(*) FROM public.wms_exceptions e
         WHERE e.business_id = p_business_id
           AND e.state::text IN ('open','acknowledged','investigating','escalated')
           AND (e.aggregate_id = r.wave_id OR e.aggregate_id = r.manifest_id)) AS exception_count,
      (SELECT e.reason FROM public.wms_exceptions e
         WHERE e.business_id = p_business_id
           AND e.state::text IN ('open','acknowledged','investigating','escalated')
           AND (e.aggregate_id = r.wave_id OR e.aggregate_id = r.manifest_id)
         ORDER BY e.severity DESC NULLS LAST, e.created_at LIMIT 1) AS exception_reason
    FROM all_rows r
    LEFT JOIN public.wms_loading_manifests m ON m.id = r.manifest_id
    LEFT JOIN public.warehouse_docks d ON d.id = m.dock_id
    LEFT JOIN public.wms_trailer_visits tv ON tv.id = m.trailer_visit_id
  ),
  staged AS (
    SELECT e.*,
      CASE
        WHEN e.dispatched_at IS NOT NULL THEN 'dispatched'
        WHEN e.manifest_state = 'closed' OR (e.carton_count > 0 AND e.carton_loaded >= e.carton_count AND e.manifest_id IS NOT NULL) THEN 'sealed'
        WHEN e.manifest_state = 'loading' OR e.carton_loaded > 0 THEN 'loading'
        WHEN e.manifest_id IS NOT NULL THEN 'manifested'
        WHEN e.carton_sealed > 0 THEN 'staged'
        WHEN e.carton_count > 0 OR e.qty_packed > 0 THEN 'packing'
        WHEN e.qty_picked > 0 THEN 'picking'
        WHEN e.released_at IS NOT NULL THEN 'released'
        ELSE 'planned'
      END AS lifecycle_stage,
      COALESCE(e.planned_departure_at, e.task_sla_at) AS sla_at
    FROM enriched e
  ),
  finalised AS (
    SELECT s.*,
      CASE
        WHEN s.exception_count > 0 THEN COALESCE(s.exception_reason, 'Open exception')
        WHEN s.blocked_tasks > 0 THEN 'Work blocked on the floor'
        WHEN s.short_lines > 0 AND s.lifecycle_stage IN ('picking','packing') THEN 'Short pick — inventory missing'
        WHEN s.lifecycle_stage = 'staged' AND s.manifest_id IS NULL THEN 'Sealed cartons not assigned to a manifest'
        WHEN s.lifecycle_stage IN ('manifested','loading') AND s.dock_id IS NULL THEN 'No dock assigned'
        WHEN s.lifecycle_stage = 'sealed' AND NOT s.has_proof THEN 'Awaiting seal and driver signature'
        WHEN s.unassigned_tasks > 0 AND s.open_tasks = s.unassigned_tasks THEN 'No operator assigned'
        ELSE NULL
      END AS blocked_reason,
      CASE WHEN s.sla_at IS NULL THEN NULL
        ELSE (EXTRACT(epoch FROM (s.sla_at - now())) / 60)::bigint END AS minutes_to_departure
    FROM staged s
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'shipments', COALESCE(jsonb_agg(x.row_json ORDER BY x.risk_rank DESC, x.sla_sort NULLS LAST, x.created_at) FILTER (WHERE true), '[]'::jsonb)
  )
  FROM (
    SELECT
      jsonb_build_object(
        'wave_id', f.wave_id,
        'wave_number', f.wave_number,
        'wave_state', f.wave_state,
        'manifest_id', f.manifest_id,
        'manifest_code', f.manifest_code,
        'manifest_state', f.manifest_state,
        'lifecycle_stage', f.lifecycle_stage,
        'created_at', f.created_at,
        'released_at', f.released_at,
        'line_count', f.line_count,
        'qty_ordered', f.qty_ordered,
        'qty_picked', f.qty_picked,
        'qty_packed', f.qty_packed,
        'short_lines', f.short_lines,
        'carton_count', f.carton_count,
        'carton_sealed', f.carton_sealed,
        'carton_manifested', f.carton_manifested,
        'carton_loaded', f.carton_loaded,
        'pick_pct', CASE WHEN f.qty_ordered > 0 THEN ROUND(100 * f.qty_picked / f.qty_ordered) ELSE NULL END,
        'pack_pct', CASE WHEN f.qty_ordered > 0 THEN ROUND(100 * f.qty_packed / f.qty_ordered) ELSE NULL END,
        'load_pct', CASE WHEN f.carton_count > 0 THEN ROUND(100.0 * f.carton_loaded / f.carton_count) ELSE NULL END,
        'open_tasks', f.open_tasks,
        'unassigned_tasks', f.unassigned_tasks,
        'blocked_tasks', f.blocked_tasks,
        'exception_count', f.exception_count,
        'blocked_reason', f.blocked_reason,
        'dock_id', f.dock_id,
        'dock_code', f.dock_code,
        'trailer_visit_id', f.trailer_visit_id,
        'trailer_ref', f.trailer_ref,
        'trailer_status', f.trailer_status,
        'has_proof', f.has_proof,
        'planned_departure_at', f.planned_departure_at,
        'dispatched_at', f.dispatched_at,
        'sla_at', f.sla_at,
        'minutes_to_departure', f.minutes_to_departure,
        'risk', CASE
          WHEN f.minutes_to_departure IS NOT NULL AND f.minutes_to_departure < 0 AND f.dispatched_at IS NULL THEN 'breached'
          WHEN f.blocked_reason IS NOT NULL THEN 'blocked'
          WHEN f.minutes_to_departure IS NOT NULL AND f.minutes_to_departure < 60 AND f.dispatched_at IS NULL THEN 'at_risk'
          WHEN f.dispatched_at IS NOT NULL THEN 'done'
          ELSE 'normal'
        END,
        'drill_route', CASE
          WHEN f.manifest_id IS NOT NULL THEN '/warehouse-app/dispatch'
          ELSE '/warehouse-app/waves'
        END
      ) AS row_json,
      CASE
        WHEN f.minutes_to_departure IS NOT NULL AND f.minutes_to_departure < 0 AND f.dispatched_at IS NULL THEN 4
        WHEN f.blocked_reason IS NOT NULL THEN 3
        WHEN f.minutes_to_departure IS NOT NULL AND f.minutes_to_departure < 60 AND f.dispatched_at IS NULL THEN 2
        WHEN f.dispatched_at IS NOT NULL THEN 0
        ELSE 1
      END AS risk_rank,
      f.sla_at AS sla_sort,
      f.created_at
    FROM finalised f
    LIMIT GREATEST(p_limit, 1)
  ) x
  );
END $function$;
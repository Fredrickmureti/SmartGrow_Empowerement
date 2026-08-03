CREATE OR REPLACE VIEW public.wms_trailer_visit_load_summary
WITH (security_invoker = true) AS
WITH manifests AS (
  SELECT m.trailer_visit_id AS visit_id,
         count(*)::int AS manifest_count,
         count(*) FILTER (WHERE m.state NOT IN ('closed','dispatched','cancelled'))::int AS open_manifest_count,
         min(m.planned_departure_at) AS earliest_planned_departure_at,
         coalesce(sum(c.carton_count), 0)::int AS carton_count
  FROM public.wms_loading_manifests m
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS carton_count
    FROM public.wms_manifest_cartons mc
    WHERE mc.manifest_id = m.id
  ) c ON true
  WHERE m.trailer_visit_id IS NOT NULL
  GROUP BY m.trailer_visit_id
),
receiving AS (
  SELECT v.id AS visit_id,
         count(s.id)::int AS receiving_session_count,
         count(s.id) FILTER (WHERE s.state NOT IN ('closed','cancelled'))::int AS open_receiving_count,
         coalesce(sum(p.expected_qty), 0)::numeric AS expected_qty,
         coalesce(sum(p.received_qty), 0)::numeric AS received_qty,
         coalesce(sum(p.damaged_qty), 0)::numeric AS damaged_qty
  FROM public.wms_trailer_visits v
  JOIN public.wms_receiving_sessions s ON s.appointment_id = v.appointment_id AND v.appointment_id IS NOT NULL
  LEFT JOIN public.wms_receiving_session_progress p ON p.session_id = s.id
  GROUP BY v.id
)
SELECT v.id AS trailer_visit_id,
       v.organization_id,
       v.business_id,
       v.warehouse_id,
       coalesce(m.manifest_count, 0) AS manifest_count,
       coalesce(m.open_manifest_count, 0) AS open_manifest_count,
       coalesce(m.carton_count, 0) AS carton_count,
       m.earliest_planned_departure_at,
       coalesce(r.receiving_session_count, 0) AS receiving_session_count,
       coalesce(r.open_receiving_count, 0) AS open_receiving_count,
       coalesce(r.expected_qty, 0) AS expected_qty,
       coalesce(r.received_qty, 0) AS received_qty,
       coalesce(r.damaged_qty, 0) AS damaged_qty,
       CASE
         WHEN coalesce(r.open_receiving_count, 0) > 0 THEN 'receiving'
         WHEN coalesce(m.open_manifest_count, 0) > 0 THEN 'loading'
         WHEN coalesce(m.manifest_count, 0) > 0 OR coalesce(r.receiving_session_count, 0) > 0 THEN 'ready'
         ELSE 'empty'
       END AS readiness
FROM public.wms_trailer_visits v
LEFT JOIN manifests m ON m.visit_id = v.id
LEFT JOIN receiving r ON r.visit_id = v.id;

GRANT SELECT ON public.wms_trailer_visit_load_summary TO authenticated;
GRANT SELECT ON public.wms_trailer_visit_load_summary TO service_role;
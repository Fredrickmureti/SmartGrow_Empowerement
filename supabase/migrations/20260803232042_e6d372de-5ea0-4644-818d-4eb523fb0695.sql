-- ============================================================
-- Cross-dock Phase 5b/6 — board view, metrics view, realtime
-- ============================================================

DROP VIEW IF EXISTS public.wms_crossdock_board_view;
CREATE VIEW public.wms_crossdock_board_view
WITH (security_invoker = true) AS
SELECT
  o.id,
  o.business_id,
  o.organization_id,
  o.branch_id,
  o.warehouse_id,
  o.state,
  o.status,
  o.score,
  o.quantity,
  o.demand_type,
  o.demand_doc_id,
  o.demand_line_id,
  o.sales_order_id,
  o.grn_id,
  o.grn_line_id,
  o.receiving_line_id,
  o.product_id,
  o.rule_id,
  o.expires_at,
  o.reject_reason,
  o.break_reason,
  o.row_version,
  o.matched_at,
  o.qualified_at,
  o.approved_at,
  o.staged_at,
  o.loaded_at,
  o.completed_at,
  o.stage_task_id,
  o.load_task_id,
  o.savings_estimate,
  o.staging_location_id,
  o.outbound_dock_id,
  o.appointment_id,
  o.assigned_user_id,
  p.name  AS product_name,
  p.sku   AS product_sku,
  w.name  AS warehouse_name,
  d.code  AS dock_code,
  sl.code AS staging_code,
  pr.full_name AS assignee_name,
  COALESCE(so.so_number, st.transfer_number) AS demand_number,
  c.name AS customer_name,
  CASE WHEN o.expires_at IS NULL THEN NULL
       ELSE EXTRACT(EPOCH FROM (o.expires_at - now())) / 3600.0 END AS hours_to_cutoff
FROM public.wms_crossdock_opportunities o
LEFT JOIN public.products p        ON p.id = o.product_id
LEFT JOIN public.warehouses w      ON w.id = o.warehouse_id
LEFT JOIN public.warehouse_docks d ON d.id = o.outbound_dock_id
LEFT JOIN public.stock_locations sl ON sl.id = o.staging_location_id
LEFT JOIN public.profiles pr       ON pr.user_id = o.assigned_user_id
LEFT JOIN public.sales_orders so   ON so.id = COALESCE(o.sales_order_id, o.demand_doc_id)
LEFT JOIN public.contacts c        ON c.id = so.contact_id
LEFT JOIN public.stock_transfers st ON st.id = o.demand_doc_id;

GRANT SELECT ON public.wms_crossdock_board_view TO authenticated;

DROP VIEW IF EXISTS public.wms_crossdock_metrics_view;
CREATE VIEW public.wms_crossdock_metrics_view
WITH (security_invoker = true) AS
SELECT
  o.business_id,
  o.warehouse_id,
  date_trunc('day', o.matched_at)::date AS metric_date,
  count(*)                                                    AS opportunities,
  count(*) FILTER (WHERE o.state = 'completed')               AS completed,
  count(*) FILTER (WHERE o.state = 'broken')                  AS broken,
  count(*) FILTER (WHERE o.state = 'expired')                 AS expired,
  count(*) FILTER (WHERE o.state = 'rejected')                AS rejected,
  ROUND(
    100.0 * count(*) FILTER (WHERE o.state = 'completed')
    / NULLIF(count(*) FILTER (WHERE o.state IN
        ('completed','broken','expired','rejected','cancelled')), 0), 1)  AS success_rate_pct,
  COALESCE(sum(o.quantity) FILTER (WHERE o.state = 'completed'), 0)       AS units_flowed,
  -- one avoided put-away + one avoided pick per completed plan
  2 * count(*) FILTER (WHERE o.state = 'completed')                       AS touches_avoided,
  -- storage days avoided: days the units would have sat before their cut-off
  COALESCE(sum(
    GREATEST(EXTRACT(EPOCH FROM (COALESCE(o.expires_at, o.completed_at) - o.matched_at)) / 86400.0, 0)
  ) FILTER (WHERE o.state = 'completed'), 0)                              AS storage_days_avoided,
  AVG(EXTRACT(EPOCH FROM (o.completed_at - o.matched_at)) / 3600.0)
    FILTER (WHERE o.state = 'completed')                                  AS avg_dwell_hours,
  COALESCE(sum(o.savings_estimate) FILTER (WHERE o.state = 'completed'), 0) AS savings_estimate
FROM public.wms_crossdock_opportunities o
GROUP BY 1, 2, 3;

GRANT SELECT ON public.wms_crossdock_metrics_view TO authenticated;

ALTER TABLE public.wms_crossdock_opportunities REPLICA IDENTITY FULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_rel pr
      JOIN pg_class c ON c.oid = pr.prrelid
      JOIN pg_publication p ON p.oid = pr.prpubid
     WHERE p.pubname = 'supabase_realtime'
       AND c.relname = 'wms_crossdock_opportunities'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.wms_crossdock_opportunities';
  END IF;
END $$;

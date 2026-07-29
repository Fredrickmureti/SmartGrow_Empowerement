
CREATE OR REPLACE VIEW public.wms_labour_queue_view
WITH (security_invoker = true) AS
SELECT
  t.id                       AS task_id,
  t.task_type,
  t.state,
  t.priority,
  t.sla_at,
  t.warehouse_id,
  t.branch_id,
  t.organization_id,
  t.business_id,
  t.zone_id,
  t.assignee_user_id,
  t.claimed_by,
  t.claimed_at,
  t.expires_at,
  t.source_location_id,
  t.destination_location_id,
  t.product_id,
  t.lot_number,
  t.lpn_id,
  t.quantity,
  t.source_doc_type,
  t.source_doc_id,
  t.row_version,
  t.created_at,
  t.updated_at,
  (t.sla_at IS NOT NULL AND t.sla_at < now()) AS sla_breached
FROM public.wms_tasks t
WHERE t.state IN ('pending','available','assigned','claimed','in_progress')
  AND (t.expires_at IS NULL OR t.expires_at > now());

CREATE OR REPLACE VIEW public.scrap_document_facts
WITH (security_invoker = on) AS
SELECT
  a.id,
  a.organization_id,
  a.business_id,
  a.branch_id,
  a.warehouse_id,
  a.adjustment_number,
  a.adjustment_date,
  a.reason,
  a.notes,
  a.status,
  a.created_by,
  a.created_at,
  a.approved_by,
  a.approved_at,
  COALESCE(line_totals.line_count, 0)::integer AS line_count,
  COALESCE(line_totals.total_quantity, 0)::numeric AS total_quantity,
  COALESCE(line_totals.total_value, 0)::numeric AS total_value,
  je.id AS journal_entry_id,
  je.entry_number AS journal_entry_number,
  je.status AS journal_entry_status,
  COALESCE(movement_totals.movement_count, 0)::integer AS movement_count,
  w.name AS warehouse_name
FROM public.stock_adjustments a
LEFT JOIN public.warehouses w ON w.id = a.warehouse_id
LEFT JOIN LATERAL (
  SELECT
    count(*) AS line_count,
    sum(abs(i.quantity_adjustment)) AS total_quantity,
    sum(abs(i.quantity_adjustment) * coalesce(i.unit_cost, 0)) AS total_value
  FROM public.stock_adjustment_items i
  WHERE i.adjustment_id = a.id
) line_totals ON true
LEFT JOIN LATERAL (
  SELECT j.id, j.entry_number, j.status
  FROM public.journal_entries j
  WHERE j.source_type = 'stock_adjustment'
    AND j.source_id = a.id
  ORDER BY j.created_at DESC
  LIMIT 1
) je ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS movement_count
  FROM public.stock_movements m
  WHERE m.reference_type = 'stock_adjustment'
    AND m.reference_id = a.id
) movement_totals ON true
WHERE a.adjustment_type = 'scrap';

GRANT SELECT ON public.scrap_document_facts TO authenticated;
GRANT SELECT ON public.scrap_document_facts TO service_role;

COMMENT ON VIEW public.scrap_document_facts IS
  'Canonical read model for scrap/waste dashboards and lists. Security invoker view over scrap stock_adjustments with totals, JE linkage, movement count, and warehouse label.';
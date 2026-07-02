
-- Recreate po_three_way_match with security_invoker so it honors the
-- caller's RLS on purchase_order_items / purchase_orders (org+business
-- isolation) instead of running as the view owner.
DROP VIEW IF EXISTS public.po_three_way_match;

CREATE VIEW public.po_three_way_match
WITH (security_invoker = true) AS
SELECT
  poi.purchase_order_id,
  poi.id                                                AS po_item_id,
  poi.product_id,
  poi.description,
  poi.quantity                                          AS qty_ordered,
  COALESCE(poi.quantity_received, 0)                    AS qty_received,
  COALESCE(poi.quantity_billed,   0)                    AS qty_billed,
  (poi.quantity - COALESCE(poi.quantity_received, 0))   AS qty_to_receive,
  (poi.quantity - COALESCE(poi.quantity_billed,   0))   AS qty_to_bill,
  (COALESCE(poi.quantity_received, 0) - COALESCE(poi.quantity_billed, 0)) AS qty_received_not_billed,
  poi.unit_price,
  poi.sort_order,
  po.organization_id,
  po.business_id,
  po.branch_id
FROM public.purchase_order_items poi
JOIN public.purchase_orders po ON po.id = poi.purchase_order_id;

GRANT SELECT ON public.po_three_way_match TO authenticated;

COMMENT ON VIEW public.po_three_way_match IS
  'Odoo-style 3-way match surface (security_invoker): per PO line, exposes ordered vs received vs billed quantities. Used by Bill vs Receipt diff panel.';

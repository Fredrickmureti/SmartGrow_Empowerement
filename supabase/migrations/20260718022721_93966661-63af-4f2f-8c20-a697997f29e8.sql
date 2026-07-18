
DROP VIEW IF EXISTS public.v_po_line_billed_progress;

CREATE VIEW public.v_po_line_billed_progress
WITH (security_invoker = true) AS
WITH matched AS (
  SELECT
    gri.purchase_order_item_id AS po_item_id,
    SUM(m.matched_quantity)    AS qty_via_grn_match
  FROM public.bill_grn_matches m
  JOIN public.goods_receipt_items gri ON gri.id = m.goods_receipt_item_id
  WHERE gri.purchase_order_item_id IS NOT NULL
  GROUP BY gri.purchase_order_item_id
),
direct_bill AS (
  SELECT
    bi.purchase_order_item_id AS po_item_id,
    SUM(bi.quantity)          AS qty_via_direct_bill_link
  FROM public.bill_items bi
  WHERE bi.purchase_order_item_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.bill_grn_matches m WHERE m.bill_item_id = bi.id
    )
  GROUP BY bi.purchase_order_item_id
)
SELECT
  poi.id                                       AS po_item_id,
  poi.purchase_order_id,
  poi.product_id,
  poi.quantity                                 AS quantity_ordered,
  COALESCE(poi.quantity_received, 0)           AS quantity_received,
  COALESCE(poi.quantity_billed,   0)           AS quantity_billed_stored,
  COALESCE(m.qty_via_grn_match, 0)             AS quantity_billed_via_grn,
  COALESCE(d.qty_via_direct_bill_link, 0)      AS quantity_billed_direct,
  COALESCE(m.qty_via_grn_match, 0) + COALESCE(d.qty_via_direct_bill_link, 0)
                                               AS quantity_billed_reconciled,
  COALESCE(poi.quantity_billed, 0)
    - (COALESCE(m.qty_via_grn_match, 0) + COALESCE(d.qty_via_direct_bill_link, 0))
                                               AS billed_drift,
  CASE
    WHEN COALESCE(poi.quantity, 0) = 0 THEN NULL
    WHEN COALESCE(poi.quantity_billed, 0) >= poi.quantity THEN 'billed'
    WHEN COALESCE(poi.quantity_billed, 0) > 0                THEN 'partially_billed'
    ELSE 'open'
  END                                           AS billing_state
FROM public.purchase_order_items poi
LEFT JOIN matched     m ON m.po_item_id = poi.id
LEFT JOIN direct_bill d ON d.po_item_id = poi.id;

GRANT SELECT ON public.v_po_line_billed_progress TO authenticated, service_role;

COMMENT ON VIEW public.v_po_line_billed_progress IS
  'Procurement P0: unified billed-progress view. billed_drift must be 0 for every row.';

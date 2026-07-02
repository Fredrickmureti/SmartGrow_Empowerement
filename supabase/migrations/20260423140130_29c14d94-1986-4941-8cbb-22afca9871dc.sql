
-- ============================================================
-- Phase A.1 — Rewrite get_ap_aging_summary to return per-vendor
-- breakdown (matches what AgedPayables.tsx expects).
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_ap_aging_summary(
  p_organization_id uuid,
  p_business_id uuid,
  p_branch_id uuid DEFAULT NULL,
  p_as_of date DEFAULT CURRENT_DATE
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' STABLE
AS $fn$
DECLARE v_result jsonb;
BEGIN
  WITH open_bills AS (
    SELECT
      b.id,
      b.bill_number,
      b.vendor_id,
      b.due_date,
      (b.total - COALESCE(b.amount_paid, 0))::numeric AS balance,
      CASE
        WHEN b.due_date >= p_as_of                           THEN 'current'
        WHEN p_as_of - b.due_date BETWEEN 1  AND 30          THEN '1-30'
        WHEN p_as_of - b.due_date BETWEEN 31 AND 60          THEN '31-60'
        WHEN p_as_of - b.due_date BETWEEN 61 AND 90          THEN '61-90'
        ELSE '90+'
      END AS bucket
    FROM bills b
    WHERE b.organization_id = p_organization_id
      AND b.business_id     = p_business_id
      AND (p_branch_id IS NULL OR b.branch_id = p_branch_id)
      AND b.status::text NOT IN ('draft','void','paid','cancelled')
      AND b.bill_date <= p_as_of
      AND (b.total - COALESCE(b.amount_paid, 0)) > 0.001
  ),
  vendor_rows AS (
    SELECT
      ob.vendor_id,
      COALESCE(c.name, 'Unknown Vendor') AS vendor_name,
      COALESCE(SUM(ob.balance) FILTER (WHERE ob.bucket = 'current'), 0)::numeric AS current_amt,
      COALESCE(SUM(ob.balance) FILTER (WHERE ob.bucket = '1-30'),    0)::numeric AS d1_30,
      COALESCE(SUM(ob.balance) FILTER (WHERE ob.bucket = '31-60'),   0)::numeric AS d31_60,
      COALESCE(SUM(ob.balance) FILTER (WHERE ob.bucket = '61-90'),   0)::numeric AS d61_90,
      COALESCE(SUM(ob.balance) FILTER (WHERE ob.bucket = '90+'),     0)::numeric AS d90_plus,
      COALESCE(SUM(ob.balance), 0)::numeric                                       AS total_amt,
      jsonb_agg(
        jsonb_build_object(
          'id',          ob.id,
          'bill_number', ob.bill_number,
          'due_date',    ob.due_date,
          'balance',     ob.balance,
          'bucket',      ob.bucket
        ) ORDER BY ob.due_date ASC
      ) AS bills
    FROM open_bills ob
    LEFT JOIN contacts c ON c.id = ob.vendor_id
    GROUP BY ob.vendor_id, c.name
  )
  SELECT jsonb_build_object(
    'as_of',   p_as_of,
    'vendors', COALESCE(jsonb_agg(
      jsonb_build_object(
        'vendor_id',   vendor_id,
        'vendor_name', vendor_name,
        'current',     current_amt,
        'days_1_30',   d1_30,
        'days_31_60',  d31_60,
        'days_61_90',  d61_90,
        'over_90',     d90_plus,
        'total',       total_amt,
        'bills',       bills
      ) ORDER BY total_amt DESC
    ), '[]'::jsonb),
    'totals', jsonb_build_object(
      'current',     COALESCE(SUM(current_amt), 0),
      'days_1_30',   COALESCE(SUM(d1_30),       0),
      'days_31_60',  COALESCE(SUM(d31_60),      0),
      'days_61_90',  COALESCE(SUM(d61_90),      0),
      'over_90',     COALESCE(SUM(d90_plus),    0),
      'total',       COALESCE(SUM(total_amt),   0),
      'vendor_count',COUNT(*)::int
    )
  ) INTO v_result
  FROM vendor_rows;

  RETURN COALESCE(v_result, jsonb_build_object(
    'as_of', p_as_of, 'vendors', '[]'::jsonb,
    'totals', jsonb_build_object(
      'current',0,'days_1_30',0,'days_31_60',0,
      'days_61_90',0,'over_90',0,'total',0,'vendor_count',0
    )
  ));
END$fn$;

GRANT EXECUTE ON FUNCTION public.get_ap_aging_summary(uuid,uuid,uuid,date) TO authenticated;

-- ============================================================
-- Phase B.5 — 3-way match view (PO line vs received vs billed).
-- Used by the new BillVsReceiptDiffPanel on PO detail.
-- ============================================================
CREATE OR REPLACE VIEW public.po_three_way_match AS
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
  'Odoo-style 3-way match surface: per PO line, exposes ordered vs received vs billed quantities. Used by Bill vs Receipt diff panel.';

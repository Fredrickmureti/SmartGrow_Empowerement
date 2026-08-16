-- Phase 12: supplier coverage projection over the canonical condition table.
CREATE OR REPLACE VIEW public.v_supplier_coverage
WITH (security_invoker = on) AS
SELECT
  p.business_id,
  p.id                       AS product_id,
  p.name                     AS product_name,
  p.sku,
  p.type                     AS product_type,
  COALESCE(c.active_conditions, 0)  AS active_conditions,
  COALESCE(c.supplier_count, 0)     AS supplier_count,
  c.min_unit_price,
  c.max_unit_price,
  c.next_expiry,
  CASE
    WHEN COALESCE(c.supplier_count, 0) = 0 THEN 'uncovered'
    WHEN c.supplier_count = 1            THEN 'single_source'
    ELSE 'multi_source'
  END AS coverage_status
FROM public.products p
LEFT JOIN LATERAL (
  SELECT count(*)                        AS active_conditions,
         count(DISTINCT t.supplier_id)   AS supplier_count,
         min(t.unit_price)               AS min_unit_price,
         max(t.unit_price)               AS max_unit_price,
         min(t.effective_to)             AS next_expiry
    FROM public.supplier_item_terms t
   WHERE t.product_id = p.id
     AND t.business_id = p.business_id
     AND t.is_active
     AND COALESCE(t.approval_status, 'approved') = 'approved'
     AND public.effective_status(t) = 'active'
) c ON true
WHERE p.is_active;

COMMENT ON VIEW public.v_supplier_coverage IS
  'Read-only projection (ADR 0142): which purchasable products have an active approved supplier condition today, and whether they are single-sourced. Derived from supplier_item_terms and public.effective_status — it stores nothing of its own.';

GRANT SELECT ON public.v_supplier_coverage TO authenticated;
GRANT SELECT ON public.v_supplier_coverage TO service_role;
REVOKE ALL ON public.v_supplier_coverage FROM anon;
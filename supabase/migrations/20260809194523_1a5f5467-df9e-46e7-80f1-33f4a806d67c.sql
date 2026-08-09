-- Phase 9.3 — data repair census + legacy numbering removal

-- 1. Remove the legacy single-argument numbering overload (source of SR-YYYY-NNNN numbers).
DROP FUNCTION IF EXISTS public.get_next_sales_return_number(uuid);

-- 2. Permanent integrity census.
CREATE OR REPLACE VIEW public.v_sales_returns_integrity
WITH (security_invoker = true)
AS
WITH prefixed AS (
  SELECT sr.*,
         COALESCE(NULLIF(b.sales_return_prefix, ''), 'SR-') AS expected_prefix
  FROM public.sales_returns sr
  LEFT JOIN public.businesses b ON b.id = sr.business_id
),
dupes AS (
  SELECT organization_id, business_id, return_number
  FROM public.sales_returns
  GROUP BY 1,2,3
  HAVING count(*) > 1
)
SELECT
  p.id AS sales_return_id,
  p.organization_id,
  p.business_id,
  p.branch_id,
  p.return_number,
  p.status,
  p.expected_prefix,
  (p.return_number IS NULL
     OR p.return_number !~ ('^' || regexp_replace(p.expected_prefix, '([\.\^\$\*\+\?\(\)\[\]\{\}\|\\])', '\\\1', 'g') || '\d+$')
  ) AS bad_number_format,
  (d.return_number IS NOT NULL) AS duplicate_number,
  (p.wms_return_order_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.stock_movements sm
      WHERE sm.reference_id = p.id AND sm.reference_type ILIKE '%return%'
  )) AS double_restock,
  (p.status = 'refunded' AND NOT COALESCE(s.is_settled, false)) AS refunded_unsettled,
  COALESCE(s.credited, 0) - COALESCE(s.applied, 0) - COALESCE(s.refunded, 0) AS settlement_shortfall,
  (SELECT count(*) FROM public.sales_return_items i
     WHERE i.sales_return_id = p.id
       AND NOT EXISTS (SELECT 1 FROM public.sales_return_cost_basis cb
                        WHERE cb.sales_return_item_id = i.id)) AS lines_without_cost_basis,
  (SELECT count(*) FROM public.sales_return_items i
     WHERE i.sales_return_id = p.id
       AND i.tax_basis_source IS NULL) AS lines_without_tax_basis
FROM prefixed p
LEFT JOIN dupes d
       ON d.organization_id = p.organization_id
      AND d.business_id IS NOT DISTINCT FROM p.business_id
      AND d.return_number = p.return_number
LEFT JOIN public.v_sales_return_settlement s ON s.sales_return_id = p.id
WHERE
     p.return_number IS NULL
  OR p.return_number !~ ('^' || regexp_replace(p.expected_prefix, '([\.\^\$\*\+\?\(\)\[\]\{\}\|\\])', '\\\1', 'g') || '\d+$')
  OR d.return_number IS NOT NULL
  OR (p.wms_return_order_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.stock_movements sm
        WHERE sm.reference_id = p.id AND sm.reference_type ILIKE '%return%'))
  OR (p.status = 'refunded' AND NOT COALESCE(s.is_settled, false))
  OR EXISTS (SELECT 1 FROM public.sales_return_items i
              WHERE i.sales_return_id = p.id
                AND (i.tax_basis_source IS NULL
                     OR NOT EXISTS (SELECT 1 FROM public.sales_return_cost_basis cb
                                     WHERE cb.sales_return_item_id = i.id)));

GRANT SELECT ON public.v_sales_returns_integrity TO authenticated;
GRANT SELECT ON public.v_sales_returns_integrity TO service_role;

COMMENT ON VIEW public.v_sales_returns_integrity IS
  'Phase 9.3 census: one row per sales return with a data defect (numbering, duplicate, double restock, unsettled refund, missing cost/tax basis).';

-- 3. Idempotent repair of legacy malformed numbers.
CREATE OR REPLACE FUNCTION public.repair_sales_return_numbers(_org_id uuid DEFAULT NULL)
RETURNS TABLE(sales_return_id uuid, old_number text, new_number text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r record;
  v_new text;
BEGIN
  FOR r IN
    SELECT v.sales_return_id AS id, v.return_number, v.organization_id, v.business_id, v.branch_id
    FROM public.v_sales_returns_integrity v
    WHERE v.bad_number_format
      AND (_org_id IS NULL OR v.organization_id = _org_id)
      AND v.business_id IS NOT NULL
    ORDER BY v.return_number NULLS FIRST
  LOOP
    v_new := public.get_next_sales_return_number(r.organization_id, r.business_id, r.branch_id);
    UPDATE public.sales_returns SET return_number = v_new, updated_at = now() WHERE id = r.id;
    sales_return_id := r.id;
    old_number := r.return_number;
    new_number := v_new;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.repair_sales_return_numbers(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.repair_sales_return_numbers(uuid) TO service_role;

COMMENT ON FUNCTION public.repair_sales_return_numbers(uuid) IS
  'Phase 9.3 repair: renumbers legacy malformed sales return numbers via the canonical generator. Idempotent.';
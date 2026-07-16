-- =====================================================================
-- ADR-0064 Phase 3 — read views over stock_quants
-- =====================================================================

CREATE OR REPLACE VIEW public.v_stock_on_hand AS
SELECT
  sq.id                 AS quant_id,
  sq.organization_id,
  sq.business_id,
  sq.branch_id,
  sq.product_id,
  sq.location_id,
  sl.warehouse_id,
  sl.code               AS location_code,
  sl.name               AS location_name,
  sl.location_type,
  sl.usage              AS location_usage,
  sq.lot_number,
  sq.package_id,
  sq.owner_id,
  sq.quantity,
  sq.reserved_quantity,
  sq.quantity - sq.reserved_quantity AS available_quantity,
  sq.updated_at
FROM public.stock_quants sq
JOIN public.stock_locations sl ON sl.id = sq.location_id;

GRANT SELECT ON public.v_stock_on_hand TO authenticated;

CREATE OR REPLACE VIEW public.v_warehouse_stock_effective AS
SELECT
  sl.warehouse_id,
  sq.product_id,
  sq.organization_id,
  sq.business_id,
  sq.branch_id,
  SUM(sq.quantity)                              AS quantity,
  SUM(sq.reserved_quantity)                     AS reserved_quantity,
  SUM(sq.quantity - sq.reserved_quantity)       AS available_quantity,
  MAX(sq.updated_at)                            AS updated_at
FROM public.stock_quants sq
JOIN public.stock_locations sl ON sl.id = sq.location_id
WHERE sl.location_type = 'internal'
GROUP BY sl.warehouse_id, sq.product_id, sq.organization_id, sq.business_id, sq.branch_id;

GRANT SELECT ON public.v_warehouse_stock_effective TO authenticated;

CREATE OR REPLACE VIEW public.v_location_summary AS
SELECT
  sl.id                 AS location_id,
  sl.warehouse_id,
  sl.business_id,
  sl.branch_id,
  sl.code,
  sl.name,
  sl.location_type,
  sl.usage,
  sl.is_active,
  sl.is_default,
  COUNT(DISTINCT sq.product_id) FILTER (WHERE sq.quantity <> 0)  AS distinct_skus,
  COALESCE(SUM(sq.quantity), 0)                                  AS total_quantity,
  COALESCE(SUM(sq.reserved_quantity), 0)                         AS total_reserved,
  MAX(sq.updated_at)                                              AS last_movement_at
FROM public.stock_locations sl
LEFT JOIN public.stock_quants sq ON sq.location_id = sl.id
GROUP BY sl.id;

GRANT SELECT ON public.v_location_summary TO authenticated;

-- Drift check helper (returns rows where warehouse_stock and quants disagree)
CREATE OR REPLACE FUNCTION public.check_stock_quant_drift(_business_id uuid DEFAULT NULL)
RETURNS TABLE (
  warehouse_id        uuid,
  product_id          uuid,
  warehouse_stock_qty numeric,
  quant_qty           numeric,
  drift               numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    ws.warehouse_id,
    ws.product_id,
    ws.quantity                                    AS warehouse_stock_qty,
    COALESCE(SUM(sq.quantity), 0)                  AS quant_qty,
    ws.quantity - COALESCE(SUM(sq.quantity), 0)    AS drift
  FROM public.warehouse_stock ws
  JOIN public.warehouses w ON w.id = ws.warehouse_id
  LEFT JOIN public.stock_locations sl
    ON sl.warehouse_id = ws.warehouse_id AND sl.location_type = 'internal'
  LEFT JOIN public.stock_quants sq
    ON sq.location_id = sl.id AND sq.product_id = ws.product_id
  WHERE (_business_id IS NULL OR w.business_id = _business_id)
    AND public.user_can_access_business(auth.uid(), w.business_id)
  GROUP BY ws.warehouse_id, ws.product_id, ws.quantity
  HAVING ws.quantity - COALESCE(SUM(sq.quantity), 0) <> 0
$$;

GRANT EXECUTE ON FUNCTION public.check_stock_quant_drift(uuid) TO authenticated;

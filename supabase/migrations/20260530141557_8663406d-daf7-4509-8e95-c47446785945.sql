-- Phase 8.1: lots-expiring-soon view, scoped per (org, business, warehouse, product, lot).
-- Surfaces every lot whose expiry_date lands within products.expiry_alert_days
-- (default 30) and which still has positive on-hand stock. RLS on the
-- underlying tables flows through (view is SECURITY INVOKER by default).
CREATE OR REPLACE VIEW public.v_lots_expiring_soon AS
SELECT
  wsl.organization_id,
  wsl.business_id,
  wsl.warehouse_id,
  w.name        AS warehouse_name,
  wsl.product_id,
  p.name        AS product_name,
  p.sku         AS product_sku,
  sl.id         AS lot_id,
  sl.lot_number,
  sl.serial_number,
  sl.expiry_date,
  (sl.expiry_date - CURRENT_DATE)::int AS days_to_expiry,
  COALESCE(p.expiry_alert_days, 30)    AS alert_window_days,
  wsl.quantity  AS quantity_on_hand,
  wsl.reserved_quantity
FROM public.warehouse_stock_lots wsl
JOIN public.stock_lots sl ON sl.id = wsl.lot_id
JOIN public.products   p  ON p.id = wsl.product_id
JOIN public.warehouses w  ON w.id = wsl.warehouse_id
WHERE wsl.quantity > 0
  AND sl.is_active IS NOT FALSE
  AND sl.expiry_date IS NOT NULL
  AND sl.expiry_date <= CURRENT_DATE + COALESCE(p.expiry_alert_days, 30)
  AND COALESCE(p.is_expiry_tracked, false) = true;

COMMENT ON VIEW public.v_lots_expiring_soon IS
  'Phase 8 expiry alerts: lots within per-product alert window with positive on-hand stock.';

GRANT SELECT ON public.v_lots_expiring_soon TO authenticated;
GRANT SELECT ON public.v_lots_expiring_soon TO service_role;
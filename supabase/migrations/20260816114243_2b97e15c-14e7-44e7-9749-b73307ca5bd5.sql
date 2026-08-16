CREATE OR REPLACE FUNCTION public.check_inventory_valuation_drift(_business_id uuid DEFAULT NULL::uuid, _tolerance numeric DEFAULT 0.01)
 RETURNS TABLE(scope text, business_id uuid, warehouse_id uuid, product_id uuid, avco_qty numeric, avco_unit_cost numeric, avco_value numeric, layer_qty numeric, layer_value numeric, value_drift numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH layers AS (
    SELECT cl.business_id, cl.warehouse_id, cl.product_id,
           SUM(cl.qty_remaining) AS qty,
           SUM(cl.qty_remaining * cl.unit_cost) AS value
      FROM public.cost_layers cl
     WHERE (_business_id IS NULL OR cl.business_id = _business_id)
     GROUP BY 1, 2, 3
  ),
  wh AS (
    SELECT ws.business_id, ws.warehouse_id, ws.product_id,
           COALESCE(ws.quantity, 0) AS qty,
           COALESCE(ws.average_cost, 0) AS unit_cost,
           ROUND(COALESCE(ws.quantity, 0) * COALESCE(ws.average_cost, 0), 2) AS value
      FROM public.warehouse_stock ws
     WHERE (_business_id IS NULL OR ws.business_id = _business_id)
  )
  SELECT 'warehouse_avco_vs_layers'::text,
         wh.business_id, wh.warehouse_id, wh.product_id,
         wh.qty, wh.unit_cost, wh.value,
         COALESCE(l.qty, 0), ROUND(COALESCE(l.value, 0), 2),
         ROUND(wh.value - COALESCE(l.value, 0), 2)
    FROM wh
    LEFT JOIN layers l
      ON l.business_id = wh.business_id
     AND l.product_id = wh.product_id
     AND l.warehouse_id IS NOT DISTINCT FROM wh.warehouse_id
   WHERE ABS(wh.value - ROUND(COALESCE(l.value, 0), 2))
         > GREATEST(_tolerance, ROUND(ABS(wh.qty) * 0.00005, 2))

  UNION ALL

  -- products.cost_price is numeric(15,2); the layer AVCO carries four
  -- decimals. Allow half a cent per unit of rounding before calling it drift.
  SELECT 'product_avco_vs_layers'::text,
         p.business_id, NULL::uuid, p.id,
         COALESCE(p.stock_quantity, 0),
         COALESCE(p.cost_price, 0),
         ROUND(COALESCE(p.stock_quantity, 0) * COALESCE(p.cost_price, 0), 2),
         COALESCE(pl.qty, 0), ROUND(COALESCE(pl.value, 0), 2),
         ROUND(COALESCE(p.stock_quantity, 0) * COALESCE(p.cost_price, 0)
               - COALESCE(pl.value, 0), 2)
    FROM public.products p
    LEFT JOIN (
      SELECT business_id, product_id, SUM(qty) AS qty, SUM(value) AS value
        FROM layers GROUP BY 1, 2
    ) pl ON pl.business_id = p.business_id AND pl.product_id = p.id
   WHERE (_business_id IS NULL OR p.business_id = _business_id)
     AND ABS(ROUND(COALESCE(p.stock_quantity, 0) * COALESCE(p.cost_price, 0), 2)
             - ROUND(COALESCE(pl.value, 0), 2))
         > GREATEST(_tolerance, ROUND(ABS(COALESCE(p.stock_quantity, 0)) * 0.005, 2));
$function$;
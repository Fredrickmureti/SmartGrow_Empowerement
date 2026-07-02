
CREATE OR REPLACE FUNCTION public.resolve_adjustment_unit_cost(
  p_org_id uuid,
  p_business_id uuid,
  p_product_id uuid,
  p_warehouse_id uuid,
  p_provided numeric
)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cost numeric;
BEGIN
  -- 1. Caller-provided cost wins when positive.
  IF p_provided IS NOT NULL AND p_provided > 0 THEN
    RETURN p_provided;
  END IF;

  -- 2. Per-warehouse moving average (still authoritative under WAC).
  SELECT average_cost INTO v_cost
    FROM public.warehouse_stock
   WHERE product_id = p_product_id
     AND warehouse_id = p_warehouse_id
   LIMIT 1;
  IF v_cost IS NOT NULL AND v_cost > 0 THEN
    RETURN v_cost;
  END IF;

  -- 3. Cost-model-aware resolution: under FIFO this returns the oldest live
  --    cost layer; under WAC it returns products.cost_price. Centralises the
  --    business-level toggle so callers don't have to branch on cost_model.
  v_cost := public.compute_unit_cost(p_business_id, p_product_id, p_warehouse_id);
  IF v_cost IS NOT NULL AND v_cost > 0 THEN
    RETURN v_cost;
  END IF;

  -- 4. Last inbound movement cost (last-resort fallback).
  SELECT unit_cost INTO v_cost
    FROM public.stock_movements
   WHERE product_id = p_product_id
     AND unit_cost IS NOT NULL
     AND unit_cost > 0
     AND quantity > 0
   ORDER BY created_at DESC
   LIMIT 1;
  IF v_cost IS NOT NULL AND v_cost > 0 THEN
    RETURN v_cost;
  END IF;

  -- 5. Give up — caller must error.
  RETURN NULL;
END;
$function$;


-- =============================================
-- Weighted Average Cost recalculation on goods receipt
-- =============================================
CREATE OR REPLACE FUNCTION public.update_weighted_avg_cost_on_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_qty numeric;
  v_old_cost numeric;
  v_new_cost numeric;
  v_new_total_qty numeric;
BEGIN
  -- Only fire on inbound movements (positive qty) for receipt/purchase types
  IF NEW.movement_type NOT IN ('receipt', 'purchase') OR NEW.quantity <= 0 THEN
    RETURN NEW;
  END IF;

  -- Skip if no unit cost on the incoming movement
  IF NEW.unit_cost IS NULL OR NEW.unit_cost <= 0 THEN
    RETURN NEW;
  END IF;

  -- Get current product stock and cost (BEFORE this movement updated stock via the other trigger)
  -- Since update_product_stock runs on the same INSERT, we read the already-updated qty
  -- So we need to subtract NEW.quantity to get the old qty
  SELECT
    COALESCE(p.stock_quantity, 0) - NEW.quantity,
    COALESCE(p.cost_price, 0)
  INTO v_old_qty, v_old_cost
  FROM products p WHERE p.id = NEW.product_id;

  -- If old qty is negative or zero, just set cost to the incoming cost
  IF v_old_qty <= 0 THEN
    v_new_cost := NEW.unit_cost;
  ELSE
    v_new_total_qty := v_old_qty + NEW.quantity;
    v_new_cost := ((v_old_qty * v_old_cost) + (NEW.quantity * NEW.unit_cost)) / v_new_total_qty;
  END IF;

  -- Update product cost_price
  UPDATE products
  SET cost_price = ROUND(v_new_cost, 4)
  WHERE id = NEW.product_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_update_wac_on_receipt ON public.stock_movements;
CREATE TRIGGER trg_update_wac_on_receipt
  AFTER INSERT ON public.stock_movements
  FOR EACH ROW
  WHEN (NEW.movement_type IN ('receipt', 'purchase') AND NEW.quantity > 0)
  EXECUTE FUNCTION public.update_weighted_avg_cost_on_receipt();

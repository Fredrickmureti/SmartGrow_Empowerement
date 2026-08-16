-- The legacy WAC trigger computed AVCO from products.stock_quantity BEFORE the
-- stock-quantity trigger had applied the receipt, so v_old_qty went negative and
-- the average was replaced by the last purchase price. It was also a second
-- costing authority beside the cost layers. Delegate to the canonical engine.
CREATE OR REPLACE FUNCTION public.update_weighted_avg_cost_on_receipt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.product_id IS NULL OR NEW.business_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Cost layers (maintained by trg_maintain_cost_layers, which fires earlier)
  -- are the single source of truth for valuation. Derive AVCO from them.
  PERFORM public.inventory_sync_avco_from_layers(
    NEW.business_id, NEW.product_id, NEW.warehouse_id);

  RETURN NEW;
END;
$function$;

-- Repair existing drift: re-derive AVCO from layers for every product/warehouse.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT business_id, product_id, warehouse_id
      FROM public.cost_layers
     WHERE qty_remaining > 0
  LOOP
    PERFORM public.inventory_sync_avco_from_layers(r.business_id, r.product_id, r.warehouse_id);
  END LOOP;
END $$;
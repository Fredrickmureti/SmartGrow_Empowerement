CREATE OR REPLACE FUNCTION public.inventory_sync_avco_from_layers(
  p_business_id uuid,
  p_product_id  uuid,
  p_warehouse_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_qty  numeric;
  v_val  numeric;
BEGIN
  IF p_business_id IS NULL OR p_product_id IS NULL THEN
    RETURN;
  END IF;

  IF p_warehouse_id IS NOT NULL THEN
    SELECT COALESCE(SUM(cl.qty_remaining), 0),
           COALESCE(SUM(cl.qty_remaining * cl.unit_cost), 0)
      INTO v_qty, v_val
      FROM public.cost_layers cl
     WHERE cl.business_id = p_business_id
       AND cl.product_id  = p_product_id
       AND cl.warehouse_id = p_warehouse_id
       AND cl.qty_remaining > 0;

    IF v_qty > 0 THEN
      UPDATE public.warehouse_stock
         SET average_cost = ROUND(v_val / v_qty, 4)
       WHERE product_id = p_product_id
         AND warehouse_id = p_warehouse_id;
    END IF;
  END IF;

  SELECT COALESCE(SUM(cl.qty_remaining), 0),
         COALESCE(SUM(cl.qty_remaining * cl.unit_cost), 0)
    INTO v_qty, v_val
    FROM public.cost_layers cl
   WHERE cl.business_id = p_business_id
     AND cl.product_id  = p_product_id
     AND cl.qty_remaining > 0;

  IF v_qty > 0 THEN
    UPDATE public.products
       SET cost_price = ROUND(v_val / v_qty, 4)
     WHERE id = p_product_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.inventory_sync_avco_from_layers(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.inventory_sync_avco_from_layers(uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.inventory_sync_avco_from_layers(uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.inventory_sync_avco_from_layers(uuid, uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public._inventory_revaluation_avco_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
BEGIN
  PERFORM public.inventory_sync_avco_from_layers(
    NEW.business_id, NEW.product_id, NEW.warehouse_id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_inventory_revaluation_avco_sync ON public.inventory_cost_revaluations;
CREATE TRIGGER trg_inventory_revaluation_avco_sync
AFTER INSERT OR UPDATE OF reversed_at, amount_applied, unit_cost_after
ON public.inventory_cost_revaluations
FOR EACH ROW EXECUTE FUNCTION public._inventory_revaluation_avco_sync();

INSERT INTO public.inventory_valuation_writers (function_name, writes_avco, writes_layers, role_description)
VALUES
  ('inventory_sync_avco_from_layers', true, false,
   'Re-derives warehouse and product AVCO from surviving cost layers after a cost revaluation (landed cost capitalisation and its reversal).'),
  ('_inventory_revaluation_avco_sync', true, false,
   'Trigger on inventory_cost_revaluations that invokes the AVCO re-derivation writer.')
ON CONFLICT (function_name) DO UPDATE
  SET writes_avco = EXCLUDED.writes_avco,
      writes_layers = EXCLUDED.writes_layers,
      role_description = EXCLUDED.role_description;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT business_id, product_id, warehouse_id
      FROM public.inventory_cost_revaluations
     WHERE reversed_at IS NULL
  LOOP
    PERFORM public.inventory_sync_avco_from_layers(r.business_id, r.product_id, r.warehouse_id);
  END LOOP;
END $$;
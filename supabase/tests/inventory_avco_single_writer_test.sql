-- Ratchet: cost layers are the only valuation authority for AVCO.
--
-- The legacy receipt trigger used to recompute products.cost_price from
-- products.stock_quantity before the stock-quantity trigger had applied the
-- receipt, so v_old_qty went negative and the average was overwritten with the
-- last purchase price. It must stay a thin delegation to the canonical engine.

DO $$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'update_weighted_avg_cost_on_receipt';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'update_weighted_avg_cost_on_receipt is missing';
  END IF;

  IF v_src NOT LIKE '%inventory_sync_avco_from_layers%' THEN
    RAISE EXCEPTION 'AVCO receipt trigger no longer delegates to inventory_sync_avco_from_layers';
  END IF;

  IF v_src LIKE '%stock_quantity%' OR v_src LIKE '%average_cost =%' THEN
    RAISE EXCEPTION 'AVCO receipt trigger reintroduced a parallel costing computation';
  END IF;
END $$;

-- Exactly one AVCO sync engine.
DO $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname = 'inventory_sync_avco_from_layers';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected exactly one inventory_sync_avco_from_layers, found %', v_n;
  END IF;
END $$;

-- Live data must carry no valuation drift between AVCO and the cost layers.
DO $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM public.check_inventory_valuation_drift();
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'inventory valuation drift detected in % scope(s)', v_n;
  END IF;
END $$;

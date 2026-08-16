-- Ratchet: a physical receipt is counted exactly once in stock_quants.
--
-- P0-1: receive_goods_to_wms relocates the balance created by the goods
-- receipt ledger onto a license plate. The relief of the loose (lpn_id IS
-- NULL) location quant used to be guarded by
--   IF v_default_location <> p_staging_location_id
-- so receiving into a staging area that IS the warehouse default location
-- added the plate quant without relieving anything — 6,000 packets became
-- 12,000. The relief must be unconditional.

DO $$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'receive_goods_to_wms';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'receive_goods_to_wms is missing';
  END IF;

  IF v_src LIKE '%v_default_location <> p_staging_location_id%' THEN
    RAISE EXCEPTION
      'receive_goods_to_wms reintroduced the conditional quant relief — receiving into the default location double-counts stock';
  END IF;

  IF v_src NOT LIKE '%SET quantity = quantity - v_line.quantity_received%' THEN
    RAISE EXCEPTION
      'receive_goods_to_wms no longer relieves the loose location quant when creating the plate quant';
  END IF;
END $$;

-- Live invariant: no product may hold the same quantity twice at one location,
-- once loose and once plate-scoped, as the double-count signature.
DO $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n
    FROM public.stock_quants loose
    JOIN public.stock_quants plate
      ON plate.product_id  = loose.product_id
     AND plate.location_id = loose.location_id
     AND COALESCE(plate.lot_number,'') = COALESCE(loose.lot_number,'')
     AND plate.quantity    = loose.quantity
     AND plate.lpn_id IS NOT NULL
   WHERE loose.lpn_id IS NULL
     AND loose.package_id IS NULL
     AND loose.quantity > 0;

  IF v_n > 0 THEN
    RAISE EXCEPTION 'stock_quants holds % double-counted receipt pair(s) (loose + plate at the same location)', v_n;
  END IF;
END $$;

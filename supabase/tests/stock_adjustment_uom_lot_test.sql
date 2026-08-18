-- Stock adjustment write seam — UoM provenance + lot identity.
--
-- Locks in the contract restored on 2026-08-18: the create RPC carries
-- packaging / display UoM / lot / serial through to stock_adjustment_items,
-- conversion stays server-side, and the lot requirement is pre-flighted
-- (never weakened).

BEGIN;

DO $$
DECLARE
  v_def text;
  v_needle text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'apply_or_request_stock_adjustment';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'apply_or_request_stock_adjustment is missing';
  END IF;

  -- 1. The INSERT must carry every provenance / identity column.
  FOREACH v_needle IN ARRAY ARRAY[
    'packaging_id', 'display_uom_id', 'display_quantity',
    'lot_number', 'serial_number', 'lot_allocations'
  ] LOOP
    IF v_def NOT LIKE '%' || v_needle || '%' THEN
      RAISE EXCEPTION 'adjustment create RPC no longer writes %', v_needle;
    END IF;
  END LOOP;

  -- 2. Packaging must be validated against the product (no client trust).
  IF v_def NOT LIKE '%product_packaging%product_id = v_product_id%' THEN
    RAISE EXCEPTION 'adjustment create RPC no longer validates packaging ownership';
  END IF;

  -- 3. Lot pre-flight must exist for positive lot-tracked lines.
  IF v_def NOT LIKE '%is_lot_tracked%' OR v_def NOT LIKE '%lot-tracked%' THEN
    RAISE EXCEPTION 'adjustment create RPC lost the lot pre-flight';
  END IF;
END $$;

-- 4. Conversion authority still lives in the BEFORE trigger.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'stock_adjustment_items'
       AND t.tgname = 'trg_uom_normalize_adj_items'
  ) THEN
    RAISE EXCEPTION 'trg_uom_normalize_adj_items is missing — conversion authority lost';
  END IF;
END $$;

-- 5. Behaviour: a pack quantity is converted to base units by the trigger.
DO $$
DECLARE
  v_org uuid; v_biz uuid; v_uom uuid; v_product uuid; v_pack uuid;
  v_adj uuid; v_item uuid; v_qty numeric; v_disp numeric;
BEGIN
  SELECT id, organization_id INTO v_biz, v_org FROM public.businesses LIMIT 1;
  IF v_biz IS NULL THEN
    RAISE NOTICE 'no business seeded — skipping behavioural half';
    RETURN;
  END IF;

  SELECT id INTO v_uom FROM public.units_of_measure WHERE business_id = v_biz LIMIT 1;
  IF v_uom IS NULL THEN
    RAISE NOTICE 'no tenant UoM seeded — skipping behavioural half';
    RETURN;
  END IF;

  INSERT INTO public.products (organization_id, business_id, name, type, base_uom_id)
  VALUES (v_org, v_biz, 'ZZ adjustment uom probe', 'product', v_uom)
  RETURNING id INTO v_product;

  INSERT INTO public.product_packaging (product_id, name, qty_in_base_uom)
  VALUES (v_product, 'Case of 12', 12)
  RETURNING id INTO v_pack;

  INSERT INTO public.stock_adjustments
    (organization_id, business_id, adjustment_number, reason, status)
  VALUES (v_org, v_biz, 'ZZ-PROBE-UOM', 'count_variance', 'draft')
  RETURNING id INTO v_adj;

  -- Operator says "2 cases"; the ledger must see 24 base units.
  INSERT INTO public.stock_adjustment_items
    (adjustment_id, product_id, quantity_before, quantity_adjustment,
     quantity_after, packaging_id, display_quantity)
  VALUES (v_adj, v_product, 0, 2, 2, v_pack, 2)
  RETURNING id INTO v_item;

  SELECT quantity_adjustment, display_quantity INTO v_qty, v_disp
    FROM public.stock_adjustment_items WHERE id = v_item;

  IF v_qty IS DISTINCT FROM 24 THEN
    RAISE EXCEPTION 'expected 24 base units from 2 x Case of 12, got %', v_qty;
  END IF;
  IF v_disp IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'display_quantity should stay 2 cases, got %', v_disp;
  END IF;
END $$;

ROLLBACK;

-- Regression test: physical-ledger provenance (Phase 3).
--
-- Why this matters:
--   `stock_movements.quantity` and `stock_quants.quantity` are canonical BASE
--   units. Before this phase the ledger could not say what the movement meant
--   commercially ("1 Bag"), and nothing was frozen: re-specifying a pack from
--   50 kg to 25 kg silently re-interpreted every historical movement.
--
--   Invariants asserted here:
--     1. Both ledger tables carry display_quantity + the three snapshot columns.
--     2. A movement written against a packaging level stamps base 50 / display 1
--        / factor 50 / base code of the product's base UoM.
--     3. Editing the packaging afterwards does not alter the stamped values.
--     4. A movement with no packaging stamps factor 1 and display = base.

BEGIN;

-- 1. Column presence ---------------------------------------------------
DO $$
DECLARE
  t text;
  c text;
  missing text[] := '{}';
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_movements','stock_quants'] LOOP
    FOREACH c IN ARRAY ARRAY[
      'display_quantity','uom_snapshot_pack_name',
      'uom_snapshot_factor','uom_snapshot_base_code'
    ] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = t AND column_name = c
      ) THEN
        missing := missing || (t || '.' || c);
      END IF;
    END LOOP;
  END LOOP;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'ledger provenance columns missing: %', missing;
  END IF;
END $$;

-- 2 + 3 + 4. Behaviour --------------------------------------------------
DO $$
DECLARE
  v_org     uuid;
  v_biz     uuid;
  v_uom     uuid;
  v_code    text;
  v_product uuid;
  v_pack    uuid;
  v_mv      uuid;
  v_disp    numeric;
  v_factor  numeric;
  v_name    text;
  v_base    text;
BEGIN
  SELECT id, organization_id INTO v_biz, v_org FROM public.businesses LIMIT 1;
  IF v_biz IS NULL THEN
    RAISE NOTICE 'no business seeded — skipping behavioural half';
    RETURN;
  END IF;

  SELECT id, COALESCE(code, name) INTO v_uom, v_code
    FROM public.units_of_measure WHERE business_id = v_biz LIMIT 1;
  IF v_uom IS NULL THEN
    RAISE NOTICE 'no tenant UoM seeded — skipping behavioural half';
    RETURN;
  END IF;

  INSERT INTO public.products (organization_id, business_id, name, type, base_uom_id)
  VALUES (v_org, v_biz, 'ZZ ledger provenance probe', 'product', v_uom)
  RETURNING id INTO v_product;

  INSERT INTO public.product_packaging (product_id, name, qty_in_base_uom)
  VALUES (v_product, 'Probe Bag', 50)
  RETURNING id INTO v_pack;

  -- Sell one 50 kg bag: the ledger moves 50 BASE units.
  INSERT INTO public.stock_movements
    (organization_id, business_id, product_id, movement_type, quantity,
     source_packaging_id)
  VALUES (v_org, v_biz, v_product, 'out', 50, v_pack)
  RETURNING id INTO v_mv;

  SELECT display_quantity, uom_snapshot_factor,
         uom_snapshot_pack_name, uom_snapshot_base_code
    INTO v_disp, v_factor, v_name, v_base
    FROM public.stock_movements WHERE id = v_mv;

  IF v_disp IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'expected display_quantity 1 Bag, got %', v_disp;
  END IF;
  IF v_factor IS DISTINCT FROM 50 THEN
    RAISE EXCEPTION 'expected factor 50, got %', v_factor;
  END IF;
  IF v_name IS DISTINCT FROM 'Probe Bag' THEN
    RAISE EXCEPTION 'expected pack name "Probe Bag", got %', v_name;
  END IF;
  IF v_base IS DISTINCT FROM v_code THEN
    RAISE EXCEPTION 'expected base code %, got %', v_code, v_base;
  END IF;

  -- The pack is re-specified later: 50 kg bags become 25 kg bags.
  UPDATE public.product_packaging
     SET qty_in_base_uom = 25, name = 'Probe Bag (small)'
   WHERE id = v_pack;

  SELECT display_quantity, uom_snapshot_factor, uom_snapshot_pack_name
    INTO v_disp, v_factor, v_name
    FROM public.stock_movements WHERE id = v_mv;

  IF v_factor IS DISTINCT FROM 50 OR v_disp IS DISTINCT FROM 1
     OR v_name IS DISTINCT FROM 'Probe Bag' THEN
    RAISE EXCEPTION
      'historical movement drifted after a packaging edit: display=% factor=% name=%',
      v_disp, v_factor, v_name;
  END IF;

  -- Loose sale: 17 base units, no packaging.
  INSERT INTO public.stock_movements
    (organization_id, business_id, product_id, movement_type, quantity)
  VALUES (v_org, v_biz, v_product, 'out', 17)
  RETURNING id INTO v_mv;

  SELECT display_quantity, uom_snapshot_factor, uom_snapshot_pack_name
    INTO v_disp, v_factor, v_name
    FROM public.stock_movements WHERE id = v_mv;

  IF v_disp IS DISTINCT FROM 17 OR v_factor IS DISTINCT FROM 1
     OR v_name IS NOT NULL THEN
    RAISE EXCEPTION
      'loose movement stamped wrongly: display=% factor=% name=%',
      v_disp, v_factor, v_name;
  END IF;
END $$;

ROLLBACK;

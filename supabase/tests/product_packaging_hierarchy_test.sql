-- Phase 3/4 guard: nested packaging hierarchy invariants and the atomic save.
--
-- Proves, inside a rolled-back transaction:
--   1. A child level whose base quantity contradicts parent x qty_in_parent is
--      rejected (PACKAGING_INCONSISTENT).
--   2. qty_in_parent is derived when omitted.
--   3. A cycle is refused (PACKAGING_CYCLE).
--   4. Depth beyond 8 levels is refused (PACKAGING_DEPTH).
--   5. A parent from another product is refused (PACKAGING_SCOPE).
--   6. Only one shipping unit per product.
--   7. save_product_atomic exists, is authenticated-only, and routes identifier
--      writes through the canonical upsert RPC (no direct table writes).

BEGIN;

DO $$
DECLARE
  v_org uuid; v_biz uuid;
  v_prod uuid; v_other uuid;
  v_base uuid; v_mid uuid; v_top uuid; v_prev uuid;
  v_qty numeric;
  v_raised boolean;
  i int;
BEGIN
  SELECT id, organization_id INTO v_biz, v_org FROM public.businesses LIMIT 1;
  IF v_biz IS NULL THEN
    RAISE NOTICE 'packaging_hierarchy_test: no business rows — skipped';
    RETURN;
  END IF;

  INSERT INTO public.products (organization_id, business_id, name, sku)
  VALUES (v_org, v_biz, 'ZZ pack hierarchy probe', 'ZZ-PACK-HIER-1')
  RETURNING id INTO v_prod;

  INSERT INTO public.products (organization_id, business_id, name, sku)
  VALUES (v_org, v_biz, 'ZZ pack hierarchy other', 'ZZ-PACK-HIER-2')
  RETURNING id INTO v_other;

  -- Base level: strip of 10.
  INSERT INTO public.product_packaging (organization_id, business_id, product_id, name, qty_in_base_uom)
  VALUES (v_org, v_biz, v_prod, 'Strip', 10) RETURNING id INTO v_base;

  -- 1. Contradiction: 5 strips must be 50 base units, not 40.
  v_raised := false;
  BEGIN
    INSERT INTO public.product_packaging (organization_id, business_id, product_id, name, qty_in_base_uom, parent_packaging_id, qty_in_parent)
    VALUES (v_org, v_biz, v_prod, 'Box', 40, v_base, 5);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'PACKAGING_INCONSISTENT%' THEN v_raised := true; ELSE RAISE; END IF;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'contradictory nested pack quantity was accepted';
  END IF;

  -- 2. qty_in_parent derived when omitted: 50 base / 10 per strip = 5.
  INSERT INTO public.product_packaging (organization_id, business_id, product_id, name, qty_in_base_uom, parent_packaging_id)
  VALUES (v_org, v_biz, v_prod, 'Box', 50, v_base) RETURNING id INTO v_mid;

  SELECT qty_in_parent INTO v_qty FROM public.product_packaging WHERE id = v_mid;
  IF v_qty IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'qty_in_parent was not derived (got %)', v_qty;
  END IF;

  -- 3. Cycle: make the parent point at its own child.
  v_raised := false;
  BEGIN
    UPDATE public.product_packaging SET parent_packaging_id = v_mid, qty_in_parent = NULL WHERE id = v_base;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'PACKAGING_CYCLE%' OR SQLERRM LIKE 'PACKAGING_INCONSISTENT%' THEN v_raised := true; ELSE RAISE; END IF;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'a packaging cycle was accepted';
  END IF;

  -- 4. Depth ceiling.
  v_prev := v_mid;
  v_qty := 50;
  v_raised := false;
  BEGIN
    FOR i IN 1..10 LOOP
      v_qty := v_qty * 2;
      INSERT INTO public.product_packaging (organization_id, business_id, product_id, name, qty_in_base_uom, parent_packaging_id, qty_in_parent)
      VALUES (v_org, v_biz, v_prod, 'Level ' || i, v_qty, v_prev, 2)
      RETURNING id INTO v_prev;
    END LOOP;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'PACKAGING_DEPTH%' THEN v_raised := true; ELSE RAISE; END IF;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'packaging depth ceiling did not fire';
  END IF;

  -- 5. Cross-product parent.
  v_raised := false;
  BEGIN
    INSERT INTO public.product_packaging (organization_id, business_id, product_id, name, qty_in_base_uom, parent_packaging_id, qty_in_parent)
    VALUES (v_org, v_biz, v_other, 'Stolen parent', 20, v_base, 2);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'PACKAGING_SCOPE%' THEN v_raised := true; ELSE RAISE; END IF;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'a parent from another product was accepted';
  END IF;

  -- 6. One shipping unit per product.
  UPDATE public.product_packaging SET is_shipping_unit = true WHERE id = v_base;
  v_raised := false;
  BEGIN
    UPDATE public.product_packaging SET is_shipping_unit = true WHERE id = v_mid;
  EXCEPTION WHEN unique_violation THEN
    v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'two shipping units on one product were accepted';
  END IF;
END $$;

-- 7. Structural contract of the atomic save.
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'save_product_atomic';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'save_product_atomic is missing';
  END IF;

  IF v_def !~* 'upsert_product_identifier' OR v_def !~* 'retire_product_identifier' THEN
    RAISE EXCEPTION 'save_product_atomic must route identifier writes through the canonical RPCs';
  END IF;

  IF v_def ~* 'insert into public\.product_identifiers'
     OR v_def ~* 'update public\.product_identifiers' THEN
    RAISE EXCEPTION 'save_product_atomic must not write product_identifiers directly';
  END IF;

  IF has_function_privilege('anon', 'public.save_product_atomic(jsonb,uuid,jsonb,jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'save_product_atomic must not be executable by anon';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.save_product_atomic(jsonb,uuid,jsonb,jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'save_product_atomic must be executable by authenticated';
  END IF;
END $$;

ROLLBACK;

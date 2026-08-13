-- Phase 2R guards for the Product physical-measure read seam and the
-- Landed Cost physical allocation bases.
--
-- Invariants proven here:
--   1. resolve_product_measure converts to the business reference unit of the
--      measure's dimension (a gram-captured weight is not summed as kilograms).
--   2. resolve_product_measure FAILS CLOSED when the business has no reference
--      unit for the dimension — previously it returned the raw captured value,
--      which let measurements in different units be summed as one basis.
--   3. Absence of the fact stays a NULL (the caller decides whether to refuse).
--   4. A packaging-level request falls back to base unit x pack size, so a case
--      weighs a case.
--   5. landed_cost_allocate_voucher measures each receipt line at its own
--      packaging level.
--
-- Everything runs inside a transaction that is rolled back; no real data is
-- mutated. Missing fixtures cause a skip, never a false pass.

BEGIN;

DO $$
DECLARE
  v_org uuid;
  v_biz uuid;
  v_prod uuid;
  v_mass_cat uuid;
  v_kg uuid;
  v_g uuid;
  v_pack uuid;
  v_base_uom uuid;
  v_val numeric;
  v_raised boolean := false;
BEGIN
  SELECT id, organization_id INTO v_biz, v_org FROM public.businesses LIMIT 1;
  IF v_biz IS NULL THEN
    RAISE NOTICE 'product_measure test: no business — skipped';
    RETURN;
  END IF;

  SELECT c.id, c.reference_uom_id INTO v_mass_cat, v_kg
    FROM public.uom_categories c
   WHERE c.business_id = v_biz AND c.dimension = 'mass'
     AND c.reference_uom_id IS NOT NULL
   ORDER BY c.created_at, c.id
   LIMIT 1;

  IF v_mass_cat IS NULL THEN
    RAISE NOTICE 'product_measure test: no mass category with a reference unit — skipped';
    RETURN;
  END IF;

  -- A non-reference unit in the same category: 1/1000 of the reference.
  INSERT INTO public.units_of_measure (
    organization_id, business_id, category_id, code, name,
    factor_to_reference, uom_type, is_active)
  VALUES (v_org, v_biz, v_mass_cat, 'ZZG', 'ZZ test gram',
          0.001, 'smaller', true)
  RETURNING id INTO v_g;

  SELECT base_uom_id INTO v_base_uom FROM public.products
   WHERE business_id = v_biz AND base_uom_id IS NOT NULL LIMIT 1;

  INSERT INTO public.products (organization_id, business_id, name, sku, base_uom_id)
  VALUES (v_org, v_biz, 'ZZ measure probe', 'ZZ-MEASURE-PROBE', v_base_uom)
  RETURNING id INTO v_prod;

  -- 3. No fact yet -> NULL, not an exception.
  v_val := public.resolve_product_measure(v_biz, v_prod, NULL, 'net_weight');
  IF v_val IS NOT NULL THEN
    RAISE EXCEPTION 'expected NULL for an unmeasured product, got %', v_val;
  END IF;

  -- Capture 500 test-grams at base level.
  INSERT INTO public.product_physical_attributes (
    organization_id, business_id, product_id, packaging_id,
    net_weight, net_weight_uom_id)
  VALUES (v_org, v_biz, v_prod, NULL, 500, v_g);

  -- 1. Converted to the reference unit: 500 * 0.001 = 0.5.
  v_val := public.resolve_product_measure(v_biz, v_prod, NULL, 'net_weight');
  IF v_val IS NULL OR round(v_val, 6) <> 0.5 THEN
    RAISE EXCEPTION 'expected 0.5 reference units, got %', v_val;
  END IF;

  -- 4. Packaging level falls back to base x pack size.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'product_packaging'
                AND column_name = 'qty_in_base_uom') THEN
    INSERT INTO public.product_packaging (
      organization_id, business_id, product_id, name, qty_in_base_uom)
    VALUES (v_org, v_biz, v_prod, 'ZZ case of 12', 12)
    RETURNING id INTO v_pack;

    v_val := public.resolve_product_measure(v_biz, v_prod, v_pack, 'net_weight');
    IF v_val IS NULL OR round(v_val, 6) <> 6.0 THEN
      RAISE EXCEPTION 'a case of 12 must weigh 12 x the base unit (6.0), got %', v_val;
    END IF;
  END IF;

  -- 2. Fail closed with no reference unit for the dimension.
  UPDATE public.uom_categories SET reference_uom_id = NULL
   WHERE business_id = v_biz AND dimension = 'mass';

  BEGIN
    v_val := public.resolve_product_measure(v_biz, v_prod, NULL, 'net_weight');
    RAISE EXCEPTION 'resolve_product_measure did NOT fail closed without a reference unit (returned %)', v_val;
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM LIKE '%no reference unit configured%' THEN
        v_raised := true;
      ELSE
        RAISE;
      END IF;
  END;

  IF NOT v_raised THEN
    RAISE EXCEPTION 'fail-closed guard did not fire';
  END IF;
END $$;

-- 5. Structural guarantee: allocation measures at the receipt line's own level
-- and capitalisation uses the canonical product account ladder.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'landed_cost_allocate_voucher'
       AND pg_get_functiondef(p.oid) ~ 'measure_packaging_id'
  ) THEN
    RAISE EXCEPTION 'landed_cost_allocate_voucher no longer measures lines at their packaging level';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_landed_cost_post_apply'
       AND pg_get_functiondef(p.oid) ~ 'resolve_product_gl_account'
  ) THEN
    RAISE EXCEPTION 'landed cost capitalisation bypasses the product GL account ladder';
  END IF;
END $$;

ROLLBACK;

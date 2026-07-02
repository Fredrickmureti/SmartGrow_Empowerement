-- Regression guard: changing products.base_uom_id is blocked once a product
-- has any stock movement, cost layer, non-zero warehouse stock, or any row
-- in a transactional line table. Mirrors enforce_base_uom_immutable
-- installed in migration 2026-06-04. Wrapped in a savepoint so the test
-- never mutates real data.

DO $$
DECLARE
  v_product uuid;
  v_other_uom uuid;
  v_same_cat_uom uuid;
  v_base uuid;
  v_cat  uuid;
  v_raised boolean := false;
BEGIN
  -- Pick a product that has at least one stock_movements row.
  SELECT p.id, p.base_uom_id, u.category_id
    INTO v_product, v_base, v_cat
  FROM public.products p
  JOIN public.units_of_measure u ON u.id = p.base_uom_id
  WHERE EXISTS (SELECT 1 FROM public.stock_movements sm WHERE sm.product_id = p.id)
  LIMIT 1;

  IF v_product IS NULL THEN
    RAISE NOTICE 'base_uom_immutable_test: no transacted product available — skipped';
    RETURN;
  END IF;

  -- Find a different UoM in the SAME category (so we don't trip the
  -- category guard; we want to prove the lock guard fires).
  SELECT id INTO v_same_cat_uom
  FROM public.units_of_measure
  WHERE category_id = v_cat AND id <> v_base
  LIMIT 1;

  IF v_same_cat_uom IS NULL THEN
    RAISE NOTICE 'base_uom_immutable_test: no sibling UoM in same category — skipped';
    RETURN;
  END IF;

  BEGIN
    UPDATE public.products
    SET base_uom_id = v_same_cat_uom
    WHERE id = v_product;
    RAISE EXCEPTION 'enforce_base_uom_immutable did NOT reject base_uom_id change on transacted product';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM LIKE 'BASE_UOM_LOCKED%' THEN
        v_raised := true;
      ELSE
        RAISE;
      END IF;
  END;

  ROLLBACK;

  IF NOT v_raised THEN
    RAISE EXCEPTION 'base_uom_immutable_test: trigger did not fire with BASE_UOM_LOCKED';
  END IF;
END $$;

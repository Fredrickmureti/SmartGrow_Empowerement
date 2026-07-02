-- Regression guard: changing `factor_to_reference` or `category_id` on a
-- units_of_measure row that is the base_uom_id of any transacted product
-- must be blocked by `enforce_uom_immutable_when_in_use`. Cosmetic edits
-- (name) must still pass. Wrapped in a savepoint so the test never
-- mutates real data.

DO $$
DECLARE
  v_uom    uuid;
  v_other_cat uuid;
  v_raised_factor   boolean := false;
  v_raised_category boolean := false;
  v_raised_cosmetic boolean := false;
BEGIN
  SELECT u.id
    INTO v_uom
  FROM public.units_of_measure u
  JOIN public.products p ON p.base_uom_id = u.id
  WHERE EXISTS (SELECT 1 FROM public.stock_movements sm WHERE sm.product_id = p.id)
  LIMIT 1;

  IF v_uom IS NULL THEN
    RAISE NOTICE 'uom_locked_when_referenced_test: no transacted base UoM available — skipped';
    RETURN;
  END IF;

  SELECT id INTO v_other_cat
  FROM public.uom_categories
  WHERE id <> (SELECT category_id FROM public.units_of_measure WHERE id = v_uom)
  LIMIT 1;

  -- 1) factor change must fail
  BEGIN
    UPDATE public.units_of_measure
      SET factor_to_reference = factor_to_reference * 10
      WHERE id = v_uom;
    RAISE EXCEPTION 'enforce_uom_immutable_when_in_use did NOT reject factor change';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM LIKE 'UOM_FACTOR_LOCKED%' THEN
        v_raised_factor := true;
      ELSE
        RAISE;
      END IF;
  END;

  -- 2) category change must fail (only if a different category exists)
  IF v_other_cat IS NOT NULL THEN
    BEGIN
      UPDATE public.units_of_measure
        SET category_id = v_other_cat
        WHERE id = v_uom;
      RAISE EXCEPTION 'enforce_uom_immutable_when_in_use did NOT reject category change';
    EXCEPTION
      WHEN raise_exception THEN
        IF SQLERRM LIKE 'UOM_CATEGORY_LOCKED%' THEN
          v_raised_category := true;
        ELSE
          RAISE;
        END IF;
    END;
  ELSE
    v_raised_category := true;  -- not applicable; treat as passed
  END IF;

  -- 3) cosmetic edit (name) must still pass
  BEGIN
    UPDATE public.units_of_measure
      SET name = name || ' (test)'
      WHERE id = v_uom;
    v_raised_cosmetic := true;  -- did not raise
  EXCEPTION WHEN OTHERS THEN
    v_raised_cosmetic := false;
  END;

  ROLLBACK;

  IF NOT v_raised_factor THEN
    RAISE EXCEPTION 'uom_locked_when_referenced_test: factor change was not blocked';
  END IF;
  IF NOT v_raised_category THEN
    RAISE EXCEPTION 'uom_locked_when_referenced_test: category change was not blocked';
  END IF;
  IF NOT v_raised_cosmetic THEN
    RAISE EXCEPTION 'uom_locked_when_referenced_test: cosmetic name change was incorrectly blocked';
  END IF;
END $$;

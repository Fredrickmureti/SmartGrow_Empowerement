-- Multi-Unit Inventory — line UoM consistency guard.
--
-- Asserts the `enforce_line_uom_consistency` trigger raises when an INSERT
-- into a transactional line table provides a `display_quantity` /
-- `packaging_id` pair whose product of factor doesn't match the base-unit
-- `quantity` column. Mirrors the contract enforced in TS by
-- `src/lib/inventory/uom.ts#toBase` so the DB defends the invariant even
-- when a misbehaving client posts directly to PostgREST.
--
-- Strategy: pick the first product that already has a packaging row with
-- factor > 1 in any business, then attempt to insert a deliberately
-- mismatched invoice_items row inside a savepoint. The savepoint is rolled
-- back regardless of outcome so this test never mutates real data.

DO $$
DECLARE
  v_product_id  uuid;
  v_pack_id     uuid;
  v_factor      numeric;
  v_org_id      uuid;
  v_business_id uuid;
  v_invoice_id  uuid;
  v_raised      boolean := false;
BEGIN
  SELECT pp.id, pp.product_id, pp.qty_in_base_uom, p.organization_id, p.business_id
    INTO v_pack_id, v_product_id, v_factor, v_org_id, v_business_id
  FROM public.product_packaging pp
  JOIN public.products p ON p.id = pp.product_id
  WHERE pp.qty_in_base_uom > 1
  LIMIT 1;

  IF v_product_id IS NULL THEN
    RAISE NOTICE 'line_uom_consistency_test: no product with packaging > 1 — skipped';
    RETURN;
  END IF;

  -- Need a real invoice header to satisfy FK; pick any in same business.
  SELECT id INTO v_invoice_id
  FROM public.invoices
  WHERE business_id = v_business_id
  LIMIT 1;

  IF v_invoice_id IS NULL THEN
    RAISE NOTICE 'line_uom_consistency_test: no invoice header for business — skipped';
    RETURN;
  END IF;

  BEGIN
    -- display_quantity=1 with a factor>1 packaging MUST imply quantity=factor.
    -- Deliberately supply quantity=1 to force the mismatch.
    INSERT INTO public.invoice_items (
      invoice_id, product_id, quantity, unit_price,
      packaging_id, display_quantity
    ) VALUES (
      v_invoice_id, v_product_id, 1, 0,
      v_pack_id, 1
    );
    -- If we got here, the trigger failed to fire.
    RAISE EXCEPTION 'enforce_line_uom_consistency did NOT reject mismatched insert';
  EXCEPTION
    WHEN check_violation THEN
      v_raised := true;
    WHEN others THEN
      -- Any other SQLSTATE means the guard is firing for the wrong reason.
      IF SQLERRM LIKE 'UoM mismatch%' THEN
        v_raised := true;
      ELSE
        RAISE;
      END IF;
  END;

  -- Make sure nothing was actually written.
  ROLLBACK;

  IF NOT v_raised THEN
    RAISE EXCEPTION 'line_uom_consistency_test: trigger did not fire';
  END IF;
END $$;

-- Regression test: the STRUCTURED UoM snapshot (Phase 2).
--
-- Why this matters:
--   `uom_snapshot` is free text ("Bag × 50 KG"). It cannot be recomputed or
--   compared, so once someone edited a pack's `qty_in_base_uom`, the meaning
--   of every already-posted document silently drifted with it. The three
--   structured columns freeze that meaning at write time:
--     uom_snapshot_pack_name / uom_snapshot_factor / uom_snapshot_base_code
--
--   This test asserts three invariants:
--     1. Every one of the 15 document-line tables carries all three columns.
--     2. A line stamps them automatically on INSERT from its packaging.
--     3. Changing the packaging factor AFTERWARDS does not alter the line's
--        snapshot — the historical document still means what it meant.

BEGIN;

-- 1. Column presence across every guarded line table -------------------
DO $$
DECLARE
  t text;
  missing text[] := '{}';
  c text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'bill_items','credit_note_items','delivery_note_items','estimate_items',
    'goods_receipt_items','invoice_items','pos_transaction_items',
    'proforma_invoice_items','purchase_order_items','purchase_return_items',
    'sales_order_items','sales_return_items','stock_adjustment_items',
    'stock_transfer_items','vendor_credit_note_items'
  ]
  LOOP
    FOREACH c IN ARRAY ARRAY[
      'uom_snapshot_pack_name','uom_snapshot_factor','uom_snapshot_base_code'
    ]
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = t AND column_name = c
      ) THEN
        missing := missing || (t || '.' || c);
      END IF;
    END LOOP;
  END LOOP;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'structured UoM snapshot columns missing: %', missing;
  END IF;
END $$;

-- 2 + 3. Stamped on write, frozen against later packaging edits --------
DO $$
DECLARE
  v_org      uuid;
  v_biz      uuid;
  v_cat      uuid;
  v_uom_kg   uuid;
  v_product  uuid;
  v_pack     uuid;
  v_invoice  uuid;
  v_line     uuid;
  v_factor   numeric;
  v_pack_nm  text;
  v_base_cd  text;
BEGIN
  SELECT id, organization_id INTO v_biz, v_org FROM public.businesses LIMIT 1;
  IF v_biz IS NULL THEN
    RAISE NOTICE 'no business seeded — skipping behavioural half of the test';
    RETURN;
  END IF;

  SELECT id, category_id INTO v_uom_kg, v_cat
    FROM public.units_of_measure
   WHERE business_id = v_biz
   LIMIT 1;
  IF v_uom_kg IS NULL THEN
    RAISE NOTICE 'no tenant UoM seeded — skipping behavioural half of the test';
    RETURN;
  END IF;

  INSERT INTO public.products (organization_id, business_id, name, type, base_uom_id)
  VALUES (v_org, v_biz, 'ZZ UoM snapshot probe', 'product', v_uom_kg)
  RETURNING id INTO v_product;

  INSERT INTO public.product_packaging (product_id, name, qty_in_base_uom)
  VALUES (v_product, 'Probe Bag', 50)
  RETURNING id INTO v_pack;

  SELECT id INTO v_invoice FROM public.invoices WHERE business_id = v_biz LIMIT 1;
  IF v_invoice IS NULL THEN
    RAISE NOTICE 'no invoice seeded — skipping behavioural half of the test';
    RETURN;
  END IF;

  -- One bag of 50 kg → 50 base units.
  INSERT INTO public.invoice_items
    (invoice_id, product_id, description, quantity, display_quantity,
     packaging_id, unit_price)
  VALUES (v_invoice, v_product, 'probe', 50, 1, v_pack, 10)
  RETURNING id INTO v_line;

  SELECT uom_snapshot_factor, uom_snapshot_pack_name, uom_snapshot_base_code
    INTO v_factor, v_pack_nm, v_base_cd
    FROM public.invoice_items WHERE id = v_line;

  IF v_factor IS DISTINCT FROM 50 THEN
    RAISE EXCEPTION 'expected stamped factor 50, got %', v_factor;
  END IF;
  IF v_pack_nm IS DISTINCT FROM 'Probe Bag' THEN
    RAISE EXCEPTION 'expected stamped pack name "Probe Bag", got %', v_pack_nm;
  END IF;
  IF v_base_cd IS NULL THEN
    RAISE EXCEPTION 'base UoM code was not stamped';
  END IF;

  -- The pack is re-specified later: 50 kg bags become 25 kg bags.
  UPDATE public.product_packaging
     SET qty_in_base_uom = 25, name = 'Probe Bag (small)'
   WHERE id = v_pack;

  SELECT uom_snapshot_factor, uom_snapshot_pack_name
    INTO v_factor, v_pack_nm
    FROM public.invoice_items WHERE id = v_line;

  IF v_factor IS DISTINCT FROM 50 THEN
    RAISE EXCEPTION
      'historical line drifted: factor became % after a packaging edit', v_factor;
  END IF;
  IF v_pack_nm IS DISTINCT FROM 'Probe Bag' THEN
    RAISE EXCEPTION
      'historical line drifted: pack name became % after a rename', v_pack_nm;
  END IF;
END $$;

ROLLBACK;

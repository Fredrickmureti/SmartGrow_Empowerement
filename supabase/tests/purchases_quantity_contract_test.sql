-- Purchases Phase 1 — the purchase quantity contract.
--
-- Invariant: every purchasing document line converts the supplier-facing
-- (entered) quantity into the canonical base quantity through exactly ONE
-- server routine, `resolve_line_base_quantity`. The browser may preview the
-- conversion; it may never author the persisted base quantity.
--
-- Introspection + arithmetic only; safe in any environment.

-- 1) The single normalizer is attached to every purchasing line table.
DO $$
DECLARE
  v_tbl text;
  v_cnt int;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY[
    'purchase_order_items',
    'goods_receipt_items',
    'bill_items',
    'purchase_return_items',
    'rfq_items',
    'purchase_requisition_items'
  ] LOOP
    SELECT count(*) INTO v_cnt
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc  p ON p.oid = t.tgfoid
     WHERE NOT t.tgisinternal
       AND c.relname = v_tbl
       AND p.proname = '_uom_normalize_line';
    IF v_cnt = 0 THEN
      RAISE EXCEPTION
        'purchasing line table % has no _uom_normalize_line trigger — the browser can author its base quantity', v_tbl;
    END IF;
  END LOOP;
END $$;

-- 2) There is only ONE conversion implementation. The retired goods-receipt
--    copy must not come back, and the normalizer must delegate to the resolver.
DO $$
DECLARE v_src text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = '_uom_normalize_line_grn') THEN
    RAISE EXCEPTION '_uom_normalize_line_grn is back — goods receipts must use the shared _uom_normalize_line';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_uom_normalize_line';
  IF v_src IS NULL THEN
    RAISE EXCEPTION '_uom_normalize_line is missing';
  END IF;
  IF v_src !~ 'resolve_line_base_quantity' THEN
    RAISE EXCEPTION '_uom_normalize_line no longer delegates to resolve_line_base_quantity';
  END IF;
END $$;

-- 3) Requisition and RFQ lines can express a packaged purchasing unit.
DO $$
DECLARE v_tbl text; v_col text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['rfq_items','purchase_requisition_items'] LOOP
    FOREACH v_col IN ARRAY ARRAY[
      'packaging_id','display_quantity','display_uom_id',
      'uom_snapshot_pack_name','uom_snapshot_factor','uom_snapshot_base_code'
    ] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = v_tbl AND column_name = v_col
      ) THEN
        RAISE EXCEPTION '%.% is missing — demand/sourcing lines lose the purchasing unit', v_tbl, v_col;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- 4) Scenarios A/B/C at the resolver level (the only conversion authority).
DO $$
DECLARE
  v_biz uuid; v_prod uuid; v_pack uuid; v_base numeric;
BEGIN
  -- Scenario A: base-unit purchase, 137.425 kg stays 137.425.
  SELECT p.id, p.business_id INTO v_prod, v_biz
    FROM public.products p
   WHERE p.base_uom_id IS NOT NULL
   LIMIT 1;
  IF v_prod IS NULL THEN
    RAISE NOTICE 'no product with a base UoM in this environment — scenario checks skipped';
    RETURN;
  END IF;

  v_base := (public.resolve_line_base_quantity(NULL, v_prod, 137.425, NULL, NULL)->>'base_quantity')::numeric;
  IF v_base <> 137.425 THEN
    RAISE EXCEPTION 'Scenario A failed: expected 137.425 base units, got %', v_base;
  END IF;

  -- Scenarios B/C: packaged purchase, entered packs × factor = base quantity.
  SELECT pk.id INTO v_pack
    FROM public.product_packaging pk
   WHERE pk.product_id = v_prod AND pk.qty_in_base_uom > 1
   LIMIT 1;
  IF v_pack IS NULL THEN
    RAISE NOTICE 'product has no multi-unit packaging — packaged scenarios skipped';
    RETURN;
  END IF;

  v_base := (public.resolve_line_base_quantity(NULL, v_prod, 10, NULL, v_pack)->>'base_quantity')::numeric;
  IF v_base <> 10 * (SELECT qty_in_base_uom FROM public.product_packaging WHERE id = v_pack) THEN
    RAISE EXCEPTION 'Scenario B/C failed: packaged conversion is not display × factor (got %)', v_base;
  END IF;
END $$;

-- 5) Scenario E: an impossible conversion is refused, never guessed.
DO $$
DECLARE v_prod uuid; v_foreign uuid;
BEGIN
  SELECT p.id INTO v_prod FROM public.products p WHERE p.base_uom_id IS NOT NULL LIMIT 1;
  IF v_prod IS NULL THEN RETURN; END IF;

  SELECT pk.id INTO v_foreign
    FROM public.product_packaging pk
   WHERE pk.product_id <> v_prod
   LIMIT 1;
  IF v_foreign IS NULL THEN RETURN; END IF;

  BEGIN
    PERFORM public.resolve_line_base_quantity(NULL, v_prod, 5, NULL, v_foreign);
    RAISE EXCEPTION 'Scenario E failed: packaging from another product was accepted';
  EXCEPTION WHEN sqlstate '22023' THEN
    NULL; -- correct: the server refuses rather than guessing
  END;
END $$;

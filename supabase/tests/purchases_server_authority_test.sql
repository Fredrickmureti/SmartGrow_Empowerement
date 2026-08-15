-- ============================================================================
-- Phase 2 — Purchases server authority over quantities.
--
-- Invariant under test: no Purchases write path may validate policy against,
-- or persist, a base quantity the browser authored. Either the RPC derives it
-- through `resolve_line_base_quantity`, or it writes through a line table that
-- carries the `_uom_normalize_line` trigger.
--
-- Run: psql -f supabase/tests/purchases_server_authority_test.sql
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The purchase-return writer derives the base quantity before it validates
--    the returnable guard. (Regression: a line could pass the guard with a
--    small `quantity` while the normalizer persisted display x factor.)
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_pret_write_lines';

  IF v_src IS NULL THEN
    RAISE EXCEPTION '_pret_write_lines is missing';
  END IF;
  IF v_src NOT ILIKE '%resolve_line_base_quantity%' THEN
    RAISE EXCEPTION '_pret_write_lines must derive the base quantity through resolve_line_base_quantity';
  END IF;
  -- The resolver call must precede the returnable comparison.
  IF position('resolve_line_base_quantity' in v_src) > position('quantity_returnable' in v_src) THEN
    RAISE EXCEPTION 'purchase return: the returnable guard runs before the quantity is derived';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. No Purchases RPC may re-implement the pack-factor arithmetic. Division by
--    `qty_in_base_uom` / a pack factor belongs to the one conversion engine.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.proname, p.prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('create_goods_receipt','update_po_items_atomic',
                         'convert_po_to_bill_atomic','requisition_create_rfq',
                         'create_purchase_requisition','_pret_write_lines',
                         'rfq_convert_awards_to_po')
  LOOP
    IF r.prosrc ~* '/\s*(NULLIF\s*\(\s*)?(pk\.)?qty_in_base_uom'
       OR r.prosrc ~* '/\s*v_pack\.factor' THEN
      RAISE EXCEPTION '% divides by a pack factor itself; delegate to resolve_line_base_quantity', r.proname;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Purchasing-unit provenance survives every document hop.
--    requisition -> rfq -> po -> grn -> bill / return.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_hops text[][] := ARRAY[
    ARRAY['requisition_create_rfq',      'packaging_id'],
    ARRAY['requisition_create_rfq',      'display_uom_id'],
    ARRAY['create_purchase_requisition', 'packaging_id'],
    ARRAY['create_purchase_requisition', 'display_quantity'],
    ARRAY['create_goods_receipt',        'packaging_id'],
    ARRAY['convert_po_to_bill_atomic',   'packaging_id'],
    ARRAY['convert_po_to_bill_atomic',   'display_uom_id'],
    ARRAY['update_po_items_atomic',      'packaging_id'],
    ARRAY['_pret_write_lines',           'packaging_id']
  ];
  i int;
  v_ok boolean;
BEGIN
  FOR i IN 1 .. array_length(v_hops, 1) LOOP
    SELECT bool_or(p.prosrc ILIKE '%' || v_hops[i][2] || '%')
      INTO v_ok
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_hops[i][1];
    IF NOT COALESCE(v_ok, false) THEN
      RAISE EXCEPTION '% drops % — the purchasing unit is lost at this hop',
        v_hops[i][1], v_hops[i][2];
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Every purchasing line table that stores a base quantity still carries the
--    normalizer (Phase 1 invariant, re-asserted here so Phase 2 edits cannot
--    detach a trigger while "simplifying" an RPC).
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchase_order_items','goods_receipt_items','bill_items',
                           'purchase_return_items','rfq_items','purchase_requisition_items']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger tg
        JOIN pg_class c ON c.oid = tg.tgrelid
        JOIN pg_proc p  ON p.oid = tg.tgfoid
       WHERE NOT tg.tgisinternal AND c.relname = t AND p.proname = '_uom_normalize_line'
    ) THEN
      RAISE EXCEPTION '% lost its _uom_normalize_line trigger', t;
    END IF;
  END LOOP;
END $$;

ROLLBACK;

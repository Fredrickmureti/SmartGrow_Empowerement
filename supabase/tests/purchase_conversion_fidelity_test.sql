-- Guard: Requisition/RFQ → PO conversions must (a) carry purchasing unit
-- provenance and (b) refuse quantities that violate supplier terms.
--
-- Both facts are structural: the conversion RPCs must reference the packaging
-- / display-unit columns and must route through the shared quantity gate
-- `_purchase_assert_order_quantity`. A conversion that silently drops the pack
-- or skips the gate is the regression this test exists to catch.

BEGIN;

DO $$
DECLARE
  fn   text;
  body text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['rfq_convert_awards_to_po','requisition_convert_to_po']
  LOOP
    SELECT p.prosrc INTO body
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = fn
     LIMIT 1;

    IF body IS NULL THEN
      RAISE EXCEPTION 'conversion RPC %.% is missing', 'public', fn;
    END IF;

    IF body NOT LIKE '%packaging_id%' THEN
      RAISE EXCEPTION '% drops packaging provenance', fn;
    END IF;
    IF body NOT LIKE '%display_uom_id%' THEN
      RAISE EXCEPTION '% drops the purchasing unit (display_uom_id)', fn;
    END IF;
    IF body NOT LIKE '%_purchase_assert_order_quantity%' THEN
      RAISE EXCEPTION '% does not enforce supplier order-quantity terms', fn;
    END IF;
  END LOOP;
END $$;

-- The gate itself: SECURITY DEFINER, and not reachable by anon/PUBLIC.
DO $$
DECLARE
  v_secdef boolean;
  v_acl    text;
BEGIN
  SELECT p.prosecdef, COALESCE(array_to_string(p.proacl, ','), '')
    INTO v_secdef, v_acl
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_purchase_assert_order_quantity'
   LIMIT 1;

  IF v_secdef IS NULL THEN
    RAISE EXCEPTION 'public._purchase_assert_order_quantity is missing';
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION '_purchase_assert_order_quantity must be SECURITY DEFINER';
  END IF;
  IF v_acl LIKE '%anon=%' THEN
    RAISE EXCEPTION '_purchase_assert_order_quantity is executable by anon';
  END IF;
END $$;

-- The PO line normalizer must still fire before the consistency check.
DO $$
DECLARE
  v_first text;
BEGIN
  SELECT t.tgname INTO v_first
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.purchase_order_items'::regclass
     AND NOT t.tgisinternal
     AND t.tgtype & 2 = 2          -- BEFORE
   ORDER BY t.tgname
   LIMIT 1;

  IF v_first IS DISTINCT FROM 'a_uom_normalize_po_items' THEN
    RAISE EXCEPTION
      'UoM normalizer no longer runs first on purchase_order_items (first BEFORE trigger: %)',
      v_first;
  END IF;
END $$;

ROLLBACK;

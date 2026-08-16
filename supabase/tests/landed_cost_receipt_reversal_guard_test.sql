-- =====================================================================
-- Ratchet: a goods receipt carrying landed cost cannot be returned/voided
-- (Phase B — 2026-08-16)
--
--   1. One shared encumbrance authority (landed_cost_receipt_encumbrance),
--      one overload, not executable by anon.
--   2. The reversal intent authority is ANNOTATED, not forked: Landed Cost
--      decorates resolve_reversal_intent_finance's goods_receipt verdict.
--   3. purchase_return_create and purchase_return_dispatch assert the guard.
--   4. purchase_return_dispatch emits a movement type the stock vocabulary
--      permits AND the cost-layer engine consumes ('vendor_return'); the old
--      'return' was in neither.
--   5. Live rehearsal (rolled back): a posted voucher blocks goods_return and
--      makes reverse_landed_cost the recommended operation.
--
-- Run:  psql "$DATABASE_URL" -f supabase/tests/landed_cost_receipt_reversal_guard_test.sql
-- =====================================================================
BEGIN;

DO $$
DECLARE
  v_src text; v_n int; v_grn uuid; v_v uuid; v_intent jsonb; v_blocked boolean := false;
BEGIN
  ------------------------------------------------ 1. one encumbrance authority
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'landed_cost_receipt_encumbrance';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL: expected exactly one landed_cost_receipt_encumbrance, found %', v_n;
  END IF;

  IF has_function_privilege('anon', 'public.landed_cost_receipt_encumbrance(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: anon can execute the landed cost encumbrance authority';
  END IF;

  ------------------------------------------- 2. intent annotated, never forked
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_reversal_intent';
  IF position('_landed_cost_annotate_reversal_intent' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: the reversal intent authority no longer consults landed cost';
  END IF;
  IF position('resolve_reversal_intent_finance' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: goods receipt reversal no longer routes through the finance authority';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_landed_cost_annotate_reversal_intent';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'FAIL: _landed_cost_annotate_reversal_intent is missing';
  END IF;
  IF position('reverse_landed_cost' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: the annotation no longer offers reversing the landed cost first';
  END IF;

  ------------------------------------------------ 3. purchase return asserts it
  FOR v_src IN
    SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('purchase_return_create','purchase_return_dispatch')
  LOOP
    IF position('landed_cost_assert_receipt_unencumbered' IN v_src) = 0 THEN
      RAISE EXCEPTION 'FAIL: a purchase return path no longer guards against landed cost';
    END IF;
  END LOOP;

  ------------------------------------------------- 4. canonical movement type
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'purchase_return_dispatch';
  IF position('''vendor_return''' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: purchase return dispatch no longer emits vendor_return';
  END IF;
  IF position('inventory_sync_avco_from_layers' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: purchase return dispatch no longer re-derives AVCO';
  END IF;

  -- the type must be legal for the table and consumed by the layer engine
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.stock_movements'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%vendor_return%') THEN
    RAISE EXCEPTION 'FAIL: vendor_return is not permitted by the stock movement vocabulary';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_maintain_cost_layers';
  IF position('vendor_return' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: the cost layer engine does not consume vendor_return';
  END IF;

  --------------------------------------------------------- 5. live rehearsal
  SELECT a.goods_receipt_id, v.id INTO v_grn, v_v
    FROM public.landed_cost_allocations a
    JOIN public.landed_cost_vouchers v ON v.id = a.voucher_id
   LIMIT 1;

  IF v_grn IS NOT NULL THEN
    UPDATE public.landed_cost_vouchers
       SET status = 'posted', reversed_at = NULL WHERE id = v_v;

    IF NOT (public.landed_cost_receipt_encumbrance(v_grn)->>'encumbered')::boolean THEN
      RAISE EXCEPTION 'FAIL: a posted voucher does not encumber its receipt';
    END IF;

    BEGIN
      PERFORM public.landed_cost_assert_receipt_unencumbered(v_grn, 'goods_return');
    EXCEPTION WHEN check_violation THEN v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'FAIL: a receipt carrying a posted landed cost can still be returned';
    END IF;

    v_intent := public._landed_cost_annotate_reversal_intent(
      jsonb_build_object('document_type','goods_receipt','document_id',v_grn,
        'blockers','[]'::jsonb,'recommended','goods_return',
        'operations', jsonb_build_array(
          jsonb_build_object('operation','goods_return','allowed',true))));

    IF (SELECT o->>'allowed' FROM jsonb_array_elements(v_intent->'operations') o
         WHERE o->>'operation' = 'goods_return') <> 'false' THEN
      RAISE EXCEPTION 'FAIL: the intent still allows returning encumbered goods';
    END IF;
    IF v_intent->>'recommended' <> 'reverse_landed_cost' THEN
      RAISE EXCEPTION 'FAIL: the intent does not recommend reversing the landed cost first';
    END IF;
  END IF;

  ------------------------------------------------------ live data invariants
  -- No dispatched purchase return may carry the retired movement type.
  IF EXISTS (SELECT 1 FROM public.stock_movements
              WHERE reference_type = 'purchase_return' AND movement_type = 'return') THEN
    RAISE EXCEPTION 'FAIL: purchase return stock movements exist with the retired ''return'' type';
  END IF;

  RAISE NOTICE 'PASS: landed cost / goods receipt reversal guard ratchet';
END $$;

ROLLBACK;

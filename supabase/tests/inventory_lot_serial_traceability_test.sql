-- ADR 0142 Phase 5 — lots, serials & traceability ratchet.
-- Fails if the direction authority, the expiry guard, the canonical
-- genealogy projection or the serial drift check regress.
BEGIN;

DO $$
DECLARE
  v_def text;
  v_missing text;
BEGIN
  -- 1. one direction authority exists and is sign-preserving
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'stock_movement_signed_quantity'
  ) THEN
    RAISE EXCEPTION 'ADR0142/P5: stock_movement_signed_quantity is missing';
  END IF;
  IF public.stock_movement_signed_quantity('pos_sale', 5) <> -5
     OR public.stock_movement_signed_quantity('receipt', 5) <> 5
     OR public.stock_movement_signed_quantity('receipt', -5) <> -5 THEN
    RAISE EXCEPTION 'ADR0142/P5: direction authority no longer normalises movement direction';
  END IF;

  -- 2. per-lot balances use the shared authority, not a private type list
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_maintain_warehouse_stock_lots';
  IF v_def IS NULL OR v_def NOT LIKE '%stock_movement_signed_quantity%' THEN
    RAISE EXCEPTION 'ADR0142/P5: _maintain_warehouse_stock_lots re-derives direction locally';
  END IF;
  FOREACH v_missing IN ARRAY ARRAY['INVENTORY_LOT_REQUIRED','INVENTORY_UNKNOWN_LOT'] LOOP
    IF v_def NOT LIKE '%' || v_missing || '%' THEN
      RAISE EXCEPTION 'ADR0142/P5: lot balance trigger no longer raises %', v_missing;
    END IF;
  END LOOP;

  -- 3. expiry policy substrate
  IF to_regclass('public.stock_lot_expiry_policies') IS NULL THEN
    RAISE EXCEPTION 'ADR0142/P5: stock_lot_expiry_policies is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'stock_lot_expiry_policies' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'ADR0142/P5: RLS is not enabled on stock_lot_expiry_policies';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'stock_movements' AND t.tgname = 'trg_enforce_lot_expiry_policy'
  ) THEN
    RAISE EXCEPTION 'ADR0142/P5: trg_enforce_lot_expiry_policy is not installed';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'enforce_lot_expiry_policy';
  FOREACH v_missing IN ARRAY ARRAY[
    'INVENTORY_EXPIRED_LOT',
    'INVENTORY_SHELF_LIFE_SHORTFALL',
    'INVENTORY_MISSING_EXPIRY',
    'resolve_lot_expiry_policy'
  ] LOOP
    IF v_def IS NULL OR v_def NOT LIKE '%' || v_missing || '%' THEN
      RAISE EXCEPTION 'ADR0142/P5: expiry guard no longer covers %', v_missing;
    END IF;
  END LOOP;

  -- 4. genealogy is a server projection and recall consumes it
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'trace_lot_genealogy'
  ) THEN
    RAISE EXCEPTION 'ADR0142/P5: trace_lot_genealogy is missing';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'recall_lot';
  IF v_def IS NULL OR v_def NOT LIKE '%trace_lot_genealogy%' THEN
    RAISE EXCEPTION 'ADR0142/P5: recall_lot re-implements the lot projection';
  END IF;

  -- 5. serial drift check
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'check_serial_position_drift'
  ) THEN
    RAISE EXCEPTION 'ADR0142/P5: check_serial_position_drift is missing';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'check_serial_position_drift';
  FOREACH v_missing IN ARRAY ARRAY['status_vs_position','warehouse_mismatch','orphan_serial'] LOOP
    IF v_def NOT LIKE '%' || v_missing || '%' THEN
      RAISE EXCEPTION 'ADR0142/P5: serial drift check lost the % scope', v_missing;
    END IF;
  END LOOP;
END $$;

ROLLBACK;

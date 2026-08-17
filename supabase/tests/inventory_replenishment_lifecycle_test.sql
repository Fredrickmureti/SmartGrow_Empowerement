-- INV-SIM (2026-08-17) — replenishment lifecycle ratchet.
-- Guards the three authoritative-layer repairs found by the end-to-end
-- inventory simulation. Each of these regressions made a whole flow
-- impossible, not merely degraded.
DO $$
DECLARE v_def text; v_check text;
BEGIN
  -- Repair #2: a fully consumed reservation settles at quantity 0.
  SELECT pg_get_constraintdef(c.oid) INTO v_check
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'stock_reservations'
     AND c.conname = 'stock_reservations_quantity_check';
  IF v_check IS NULL THEN
    RAISE EXCEPTION 'INV-SIM: stock_reservations_quantity_check is missing';
  END IF;
  IF v_check !~ 'quantity >= \(0\)' AND v_check !~ 'quantity >= 0' THEN
    RAISE EXCEPTION 'INV-SIM: quantity check must allow 0 for consumed reservations — got %', v_check;
  END IF;
  IF v_check !~ 'reserved' OR v_check !~ 'allocated' THEN
    RAISE EXCEPTION 'INV-SIM: quantity check must still force positivity on OPEN reservations — got %', v_check;
  END IF;

  -- Repair #3: replenishment completion casts the order state to its enum.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'complete_replenish_task';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'INV-SIM: complete_replenish_task is missing';
  END IF;
  IF v_def !~ 'wms_replen_order_state' THEN
    RAISE EXCEPTION 'INV-SIM: complete_replenish_task must cast state to wms_replen_order_state (42804 regression)';
  END IF;

  -- Repair #4: per-lot balances follow location semantics, not movement type.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_maintain_warehouse_stock_lots';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'INV-SIM: _maintain_warehouse_stock_lots is missing';
  END IF;
  IF v_def !~ 'source_location_id' OR v_def !~ 'destination_location_id' THEN
    RAISE EXCEPTION 'INV-SIM: lot maintainer must be location-aware — intra-warehouse transfers must net to zero';
  END IF;
END $$;

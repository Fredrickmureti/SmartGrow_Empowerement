-- =====================================================================
-- Ratchet: landed cost must follow stock across warehouses
-- (Phase B item 1 — 2026-08-16)
--
-- Introspective invariants for the three defects fixed on 2026-08-16:
--
--   1. stock_movements permits the movement vocabulary the canonical
--      engines actually emit (transfer_out / transfer_in and friends),
--      and every permitted type is classified for the event fabric.
--   2. the business transit location belongs to the in-transit warehouse,
--      so dispatched stock projects onto warehouse balances and a transfer
--      can be received.
--   3. an inbound transfer leg inherits its unit cost from the layers it
--      descends from, and re-derives destination AVCO through the
--      registered valuation writer.
--
-- Run:  psql "$DATABASE_URL" -f supabase/tests/landed_cost_transfer_lineage_test.sql
-- =====================================================================
BEGIN;

DO $$
DECLARE
  v_src text;
  v_def text;
  v_missing text;
BEGIN
  ------------------------------------------------- movement type vocabulary
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.stock_movements'::regclass
     AND conname = 'stock_movements_movement_type_check';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'FAIL: stock_movements_movement_type_check is missing';
  END IF;

  FOREACH v_missing IN ARRAY ARRAY[
    'transfer_out','transfer_in','adjustment_in','adjustment_out',
    'opening_stock','customer_return','vendor_return']
  LOOP
    IF position('''' || v_missing || '''' IN v_def) = 0 THEN
      RAISE EXCEPTION 'FAIL: movement type % is emitted by the engines but rejected by the constraint', v_missing;
    END IF;
  END LOOP;

  ------------------------------------- every permitted type is classified
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('transfer_out'),('transfer_in'),('adjustment_in'),('adjustment_out'),
        ('opening_stock'),('customer_return'),('vendor_return'),
        ('receipt'),('sale'),('pos_sale'),('transfer')) AS t(mt)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.inventory_movement_event_classes c
        WHERE c.movement_type = t.mt)
  ) THEN
    RAISE EXCEPTION 'FAIL: a permitted movement type has no row in inventory_movement_event_classes';
  END IF;

  --------------------------------------------------- transit is warehouse-owned
  IF EXISTS (
    SELECT 1 FROM public.stock_locations
     WHERE location_type = 'transit' AND warehouse_id IS NULL
  ) THEN
    RAISE EXCEPTION 'FAIL: a transit location has no warehouse; dispatched stock cannot project onto warehouse balances';
  END IF;

  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_business_transit_location';

  IF v_src IS NULL OR position('get_or_create_in_transit_warehouse' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: the transit location is no longer scoped to the in-transit warehouse';
  END IF;

  ------------------------------------------------- transfer cost inheritance
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_maintain_cost_layers';

  IF position('cost_layer_lineage' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: transfer legs no longer record cost layer lineage';
  END IF;
  IF position('inventory_sync_avco_from_layers' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: destination AVCO is no longer re-derived through the registered valuation writer';
  END IF;
  IF position('v_inherited' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: an inbound transfer leg no longer inherits its unit cost (zero-cost stock at destination)';
  END IF;

  ------------------------------------------------------ live data invariants
  -- No transferred stock sitting at zero cost.
  IF EXISTS (
    SELECT 1
      FROM public.cost_layers cl
      JOIN public.stock_movements m ON m.id = cl.source_movement_id
     WHERE m.reference_type = 'stock_transfer'
       AND cl.qty_remaining > 0
       AND COALESCE(cl.unit_cost, 0) = 0
  ) THEN
    RAISE EXCEPTION 'FAIL: transferred stock is held at zero cost';
  END IF;

  RAISE NOTICE 'PASS: landed cost transfer lineage ratchet';
END $$;

ROLLBACK;

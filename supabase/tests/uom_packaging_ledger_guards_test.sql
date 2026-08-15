-- Guard tests for the sugar / UoM-packaging simulation remediation.
--
-- Four defects were found by driving a real weight-based product (Sugar, base
-- KG, sold loose and as a 50 kg Bag) through receiving, sales, delivery and
-- POS:
--   1. set_invoice_status_atomic called user_has_business_access/1 (signature
--      is /2) — every invoice status change failed with 42883.
--   2. Pack provenance was resolved AFTER the ledger row was inserted, so the
--      snapshot trigger had already frozen pack_name = NULL / factor = 1 and a
--      1-bag delivery was recorded as "-50" with no commercial meaning.
--   3. Countable base units accepted fractional movements (2.5 chairs sold).
--   4. Opening stock lines keyed anything other than `quantity_adjustment`
--      were silently ignored — the product was created with zero stock.
--
-- Introspection only; safe in any environment.

-- 1) Invoice status writer passes an actor to the 2-arg access check.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'set_invoice_status_atomic';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'set_invoice_status_atomic is missing';
  END IF;
  IF v_src ~* 'user_has_business_access\s*\(\s*v_inv\.business_id\s*\)' THEN
    RAISE EXCEPTION 'set_invoice_status_atomic still calls user_has_business_access with one argument (42883 at runtime)';
  END IF;
  IF v_src !~* 'user_has_business_access\s*\(\s*v_actor\s*,' THEN
    RAISE EXCEPTION 'set_invoice_status_atomic must pass the acting user as the first argument';
  END IF;
END $$;

-- 2) Pack provenance is resolved BEFORE the ledger snapshot is frozen, and
--    alphabetically before the snapshot trigger (BEFORE triggers fire by name).
DO $$
DECLARE v_backfill_type int2; v_snapshot_type int2; v_src text;
BEGIN
  SELECT tgtype INTO v_backfill_type FROM pg_trigger
   WHERE tgrelid = 'public.stock_movements'::regclass
     AND tgname = 'trg_backfill_movement_packaging';
  SELECT tgtype INTO v_snapshot_type FROM pg_trigger
   WHERE tgrelid = 'public.stock_movements'::regclass
     AND tgname = 'trg_stamp_ledger_uom_snapshot';

  IF v_backfill_type IS NULL OR v_snapshot_type IS NULL THEN
    RAISE EXCEPTION 'stock_movements provenance triggers are missing';
  END IF;
  -- bit 1 (value 2) set = BEFORE
  IF (v_backfill_type & 2) = 0 THEN
    RAISE EXCEPTION 'trg_backfill_movement_packaging must be BEFORE INSERT, otherwise the pack snapshot is frozen loose';
  END IF;
  IF 'trg_backfill_movement_packaging' >= 'trg_stamp_ledger_uom_snapshot' THEN
    RAISE EXCEPTION 'backfill trigger must sort before the snapshot trigger';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_backfill_movement_packaging';
  IF v_src ~* 'UPDATE\s+public\.stock_movements' THEN
    RAISE EXCEPTION '_backfill_movement_packaging must assign NEW.* in a BEFORE trigger, not UPDATE the row afterwards';
  END IF;
  IF v_src !~* 'NEW\.source_packaging_id\s*:=' THEN
    RAISE EXCEPTION '_backfill_movement_packaging must set NEW.source_packaging_id';
  END IF;
END $$;

-- 3) Countable base units (rounding >= 1) reject fractional stock movements.
DO $$
DECLARE v_type int2; v_src text;
BEGIN
  SELECT tgtype INTO v_type FROM pg_trigger
   WHERE tgrelid = 'public.stock_movements'::regclass
     AND tgname = 'trg_enforce_movement_uom_granularity';
  IF v_type IS NULL THEN
    RAISE EXCEPTION 'integrality guard trigger is missing — fractional counts (2.5 chairs) would post';
  END IF;
  IF (v_type & 2) = 0 THEN
    RAISE EXCEPTION 'integrality guard must run BEFORE INSERT';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_enforce_movement_uom_granularity';
  IF v_src !~* 'units_of_measure' OR v_src !~* 'rounding' THEN
    RAISE EXCEPTION 'integrality guard must derive granularity from units_of_measure.rounding, not a hardcoded unit list';
  END IF;
  IF v_src !~* 'mod\s*\(' THEN
    RAISE EXCEPTION 'integrality guard must check the quantity is a whole multiple of the rounding step';
  END IF;
END $$;

-- Functional probe: the guard is dimension-generic — it must fire for a
-- countable unit and stay silent for weight/volume/length.
DO $$
DECLARE v_bad int; 
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.units_of_measure u
   WHERE u.code IN ('KG','L','M') AND u.rounding >= 1;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'continuous units (KG/L/M) must keep a sub-unit rounding step or the guard would block legitimate 2.5 kg sales';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.units_of_measure WHERE code = 'PCE' AND rounding >= 1) THEN
    RAISE EXCEPTION 'PCE must carry rounding >= 1 so countable products are integral';
  END IF;
END $$;

-- 4) Opening stock rejects mis-keyed payloads instead of silently no-op'ing.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_product_with_opening_stock_atomic';
  IF v_src !~* 'OPENING_STOCK_BAD_PAYLOAD' THEN
    RAISE EXCEPTION 'create_product_with_opening_stock_atomic must reject opening lines without quantity_adjustment';
  END IF;
END $$;

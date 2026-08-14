-- ADR 0142 — one reservation engine.
-- Fails if a second reservation writer reappears, or if the lifecycle
-- columns / projection guards are missing.
BEGIN;

DO $$
DECLARE v_missing text;
BEGIN
  -- 1. the engine exists
  FOREACH v_missing IN ARRAY ARRAY[
    'reserve_stock_atomic',
    'allocate_stock_reservation',
    'consume_stock_reservation',
    'consume_stock_reservations_for_source',
    'release_stock_reservation',
    'release_stock_reservations_for_source',
    'expire_stock_reservations',
    'stock_reservation_is_open',
    'refresh_quant_reserved_projection'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = v_missing
    ) THEN
      RAISE EXCEPTION 'ADR0142: missing reservation engine function %', v_missing;
    END IF;
  END LOOP;

  -- 2. the duplicate engines stay dead
  FOREACH v_missing IN ARRAY ARRAY[
    'reserve_stock', 'create_stock_reservation', 'release_stock', 'release_reserved_stock'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = v_missing
    ) THEN
      RAISE EXCEPTION 'ADR0142: duplicate reservation writer % reappeared', v_missing;
    END IF;
  END LOOP;

  -- 3. lifecycle columns
  FOREACH v_missing IN ARRAY ARRAY[
    'status','quantity_consumed','original_quantity','location_id',
    'lot_number','idempotency_key','release_reason','metadata','consumed_at'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'stock_reservations'
         AND column_name = v_missing
    ) THEN
      RAISE EXCEPTION 'ADR0142: stock_reservations.% is missing', v_missing;
    END IF;
  END LOOP;

  -- 4. projections and guards are wired
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_project_warehouse_stock_reservations') THEN
    RAISE EXCEPTION 'ADR0142: warehouse_stock reservation projection trigger missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_quant_reserved') THEN
    RAISE EXCEPTION 'ADR0142: quant reserved-is-derived guard missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_stock_reservations_sync_state') THEN
    RAISE EXCEPTION 'ADR0142: reservation lifecycle sync trigger missing';
  END IF;

  -- 5. no function outside the engine may write reserved counters
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND pg_get_functiondef(p.oid) ILIKE '%INTO public.stock_reservations%'
       AND p.proname <> 'reserve_stock_atomic'
  ) THEN
    RAISE EXCEPTION 'ADR0142: a function other than reserve_stock_atomic inserts reservations';
  END IF;
END $$;

ROLLBACK;

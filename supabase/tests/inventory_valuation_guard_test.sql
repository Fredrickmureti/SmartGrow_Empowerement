-- =====================================================================
-- Ratchet: inventory costing & valuation guard (ADR 0078 — Phase 4)
--
-- Fails if the single-valuation-engine guarantees regress:
--   * the valuation writer registry disappears or empties
--   * the write-authority triggers are dropped
--   * any guard error code is removed from the trigger body
--   * unregistered costing logic appears
--   * the valuation drift report stops covering both AVCO scopes
--
-- Run:  psql "$DATABASE_URL" -f supabase/tests/inventory_valuation_guard_test.sql
-- =====================================================================
BEGIN;

DO $$
DECLARE
  v_count integer;
  v_src   text;
  v_rows  text;
BEGIN
  ---------------------------------------------------------------- registry
  SELECT count(*) INTO v_count FROM public.inventory_valuation_writers;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'FAIL: inventory_valuation_writers registry is empty';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.inventory_valuation_writers
     WHERE function_name = 'update_weighted_avg_cost_on_receipt' AND writes_avco
  ) THEN
    RAISE EXCEPTION 'FAIL: canonical AVCO engine is not registered as a valuation writer';
  END IF;

  ---------------------------------------------------------------- triggers
  SELECT count(*) INTO v_count
    FROM pg_trigger
   WHERE tgname IN ('trg_enforce_valuation_authority_ws',
                    'trg_enforce_valuation_authority_cl')
     AND NOT tgisinternal;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'FAIL: expected both valuation authority triggers, found %', v_count;
  END IF;

  ------------------------------------------------------------ guard bodies
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'enforce_valuation_write_authority';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'FAIL: enforce_valuation_write_authority() is missing';
  END IF;

  IF position('INVENTORY_VALUATION_WRITE_DENIED' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: API-client valuation writes are no longer denied';
  END IF;
  IF position('INVENTORY_LAYER_IMMUTABLE' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: cost layer provenance is no longer immutable';
  END IF;
  IF position('INVENTORY_NEGATIVE_VALUATION' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: negative valuation guard was removed';
  END IF;
  IF position('INVENTORY_LAYER_QTY_RANGE' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: cost layer quantity range guard was removed';
  END IF;

  ------------------------------------------------------------- one engine
  SELECT string_agg(issue || ':' || function_name, ', ')
    INTO v_rows
    FROM public.check_valuation_writer_coverage();
  IF v_rows IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: valuation writer coverage regressed -> %', v_rows;
  END IF;

  --------------------------------------------------------- drift coverage
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'check_inventory_valuation_drift';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'FAIL: check_inventory_valuation_drift() is missing';
  END IF;
  IF position('warehouse_avco_vs_layers' IN v_src) = 0
     OR position('product_avco_vs_layers' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: valuation drift check no longer covers both AVCO scopes';
  END IF;

  RAISE NOTICE 'PASS: inventory valuation guard ratchet';
END $$;

ROLLBACK;

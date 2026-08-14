-- ADR 0142 Phase 3 — movement ledger completeness ratchet.
-- Fails if provenance, the value/quantity split, reversal parity, or the
-- four-way drift check regresses.
BEGIN;

DO $$
DECLARE
  v_missing text;
  v_def text;
  v_row record;
BEGIN
  -- 1. registries exist
  IF to_regclass('public.stock_movement_source_types') IS NULL THEN
    RAISE EXCEPTION 'ADR0142/P3: stock_movement_source_types registry is missing';
  END IF;
  IF to_regclass('public.stock_movement_writers') IS NULL THEN
    RAISE EXCEPTION 'ADR0142/P3: stock_movement_writers registry is missing';
  END IF;

  -- 2. the integrity trigger is installed on stock_movements
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'stock_movements'
       AND t.tgname = 'trg_enforce_stock_movement_integrity'
  ) THEN
    RAISE EXCEPTION 'ADR0142/P3: trg_enforce_stock_movement_integrity is missing';
  END IF;

  -- 3. the guard still enforces provenance and the value/quantity split
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'enforce_stock_movement_integrity';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'ADR0142/P3: enforce_stock_movement_integrity is missing';
  END IF;
  FOREACH v_missing IN ARRAY ARRAY[
    'INVENTORY_MOVEMENT_NO_PROVENANCE',
    'INVENTORY_UNKNOWN_SOURCE_TYPE',
    'INVENTORY_DANGLING_PROVENANCE',
    'INVENTORY_VALUE_ONLY_MOVEMENT',
    'INVENTORY_EMPTY_MOVEMENT'
  ] LOOP
    IF v_def NOT LIKE '%' || v_missing || '%' THEN
      RAISE EXCEPTION 'ADR0142/P3: guard no longer raises %', v_missing;
    END IF;
  END LOOP;

  -- 4. every registered source type that names a table names a real one
  FOR v_row IN
    SELECT reference_type, target_table
      FROM public.stock_movement_source_types
     WHERE target_table IS NOT NULL
  LOOP
    IF to_regclass('public.' || v_row.target_table) IS NULL THEN
      RAISE EXCEPTION 'ADR0142/P3: source type % points at missing table public.%',
        v_row.reference_type, v_row.target_table;
    END IF;
  END LOOP;

  -- 5. reversal parity: no unregistered writer, no stale or broken reversal
  FOR v_row IN SELECT * FROM public.check_movement_reversal_coverage() LOOP
    RAISE EXCEPTION 'ADR0142/P3: reversal coverage failure — % on % (%)',
      v_row.issue, v_row.function_name, v_row.detail;
  END LOOP;

  -- 6. drift detection covers all four balance stores
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'check_stock_quant_drift';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'ADR0142/P3: check_stock_quant_drift is missing';
  END IF;
  FOREACH v_missing IN ARRAY ARRAY[
    'stock_quants', 'warehouse_stock', 'warehouse_stock_lots', 'products'
  ] LOOP
    IF v_def NOT LIKE '%' || v_missing || '%' THEN
      RAISE EXCEPTION 'ADR0142/P3: drift check no longer covers %', v_missing;
    END IF;
  END LOOP;
  IF v_def NOT LIKE '%scope%' THEN
    RAISE EXCEPTION 'ADR0142/P3: drift check lost its scope column';
  END IF;
END $$;

ROLLBACK;

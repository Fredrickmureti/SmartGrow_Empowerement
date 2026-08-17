-- Phase 6 — handling unit vs product packaging ratchet.
-- Fails if plate concurrency, server-side UoM conversion, or the container
-- capacity guard regresses.
BEGIN;

DO $$
DECLARE
  v_name text;
  v_def text;
  v_args text;
BEGIN
  -- 1. every plate mutator demands a row version (no DEFAULT NULL escape).
  FOREACH v_name IN ARRAY ARRAY[
    'wms_lpn_load','wms_lpn_unload','wms_lpn_split','wms_lpn_merge',
    'wms_lpn_nest','wms_lpn_unnest','wms_lpn_move','wms_lpn_seal',
    'wms_lpn_retire','wms_lpn_dispatch','wms_lpn_receive_return',
    'wms_lpn_set_packaging'
  ] LOOP
    SELECT pg_get_function_arguments(p.oid) INTO v_args
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_args IS NULL THEN
      RAISE EXCEPTION 'WMS/P6: % is missing', v_name;
    END IF;
    IF v_args NOT LIKE '%_expected_version integer%' THEN
      RAISE EXCEPTION 'WMS/P6: % does not take _expected_version', v_name;
    END IF;
    IF v_args LIKE '%_expected_version integer DEFAULT%' THEN
      RAISE EXCEPTION 'WMS/P6: % made _expected_version optional again', v_name;
    END IF;
  END LOOP;

  -- 2. capture RPCs convert through the ONE server-side UoM authority.
  FOREACH v_name IN ARRAY ARRAY['wms_lpn_load','wms_lpn_unload','wms_lpn_split'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_def NOT LIKE '%wms_to_base_qty%' THEN
      RAISE EXCEPTION 'WMS/P6: % no longer converts via wms_to_base_qty', v_name;
    END IF;
    IF pg_get_function_arguments((
         SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = v_name)) NOT LIKE '%packaging_id%'
       AND v_name <> 'wms_lpn_split' THEN
      RAISE EXCEPTION 'WMS/P6: % lost its packaging level argument', v_name;
    END IF;
  END LOOP;

  -- 3. no plate mutator may accept a version and then ignore it.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE 'wms_lpn_%'
       AND pg_get_functiondef(p.oid) LIKE '%COALESCE(_expected_version%'
  ) THEN
    RAISE EXCEPTION 'WMS/P6: a plate RPC reintroduced a COALESCE version fallback';
  END IF;

  -- 4. the container capacity guard exists, is policy driven, and reads the
  --    canonical product weights rather than a warehouse-local copy.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_wms_lpn_capacity_check';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'WMS/P6: _wms_lpn_capacity_check is missing';
  END IF;
  FOREACH v_name IN ARRAY ARRAY[
    'product_physical_attributes', 'wms_packaging_types',
    'enforce_handling_unit_capacity', 'WMS_LPN_OVER_CAPACITY', 'wms_exceptions'
  ] LOOP
    IF v_def NOT LIKE '%' || v_name || '%' THEN
      RAISE EXCEPTION 'WMS/P6: capacity guard no longer references %', v_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'warehouses'
       AND column_name = 'enforce_handling_unit_capacity'
  ) THEN
    RAISE EXCEPTION 'WMS/P6: warehouses.enforce_handling_unit_capacity is missing';
  END IF;

  -- 5. load/merge actually invoke the guard.
  FOREACH v_name IN ARRAY ARRAY['wms_lpn_load','wms_lpn_merge'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_def NOT LIKE '%_wms_lpn_capacity_check%' THEN
      RAISE EXCEPTION 'WMS/P6: % does not run the capacity guard', v_name;
    END IF;
  END LOOP;

  -- 6. INV-SIM 2026-08-17: a version conflict must NOT be raised as SQLSTATE
  --    40001. The API layer retries serialization failures, so a stale plate
  --    call never returned, leaked an aborted open transaction and wedged the
  --    plate row for every later operator.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND pg_get_functiondef(p.oid) ~ '''(wms_lpn_stale|wms_task_stale)[^'']*''[^;]*40001'
  ) THEN
    RAISE EXCEPTION 'WMS/P6: a plate/task conflict is raised as retryable 40001 again';
  END IF;

  -- 7. every plate mutator that takes a row lock must bound the wait, so one
  --    abandoned request cannot park the connection pool on a single plate.
  FOR v_name IN
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE 'wms_lpn_%'
       AND pg_get_functiondef(p.oid) ~* 'FOR UPDATE'
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = v_name
         AND array_to_string(p.proconfig, ',') LIKE '%lock_timeout%'
    ) THEN
      RAISE EXCEPTION 'WMS/P6: % locks rows without a bounded lock_timeout', v_name;
    END IF;
  END LOOP;
END $$;

ROLLBACK;

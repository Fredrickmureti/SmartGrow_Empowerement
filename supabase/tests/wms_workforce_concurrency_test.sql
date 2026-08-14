-- Phase 7 — Workforce supervisor mutators must stay optimistically concurrent.
BEGIN;

DO $$
DECLARE
  v_name text;
  v_args text;
  v_def text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'wms_reassign_task','wms_release_task','wms_set_task_priority','wms_set_operator_status'
  ] LOOP
    SELECT pg_get_function_arguments(p.oid), pg_get_functiondef(p.oid)
      INTO v_args, v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_args IS NULL THEN
      RAISE EXCEPTION 'WMS/P7: % is missing', v_name;
    END IF;
    IF v_args NOT LIKE '%p_row_version integer%' THEN
      RAISE EXCEPTION 'WMS/P7: % does not take p_row_version', v_name;
    END IF;
    IF v_args LIKE '%p_row_version integer DEFAULT%' THEN
      RAISE EXCEPTION 'WMS/P7: % made p_row_version optional', v_name;
    END IF;
    -- the guard may be inlined or delegated to the shared locker
    IF v_def NOT LIKE '%_wms_task_locked%'
       AND (v_def NOT LIKE '%_stale%' OR v_def NOT LIKE '%_version_required%') THEN
      RAISE EXCEPTION 'WMS/P7: % lost its stale / missing-version guard', v_name;
    END IF;
    IF v_def NOT LIKE '%_wms_assert_business_access%' AND v_def NOT LIKE '%_wms_task_locked%' THEN
      RAISE EXCEPTION 'WMS/P7: % lost its tenant check', v_name;
    END IF;
  END LOOP;

  -- the shared task locker owns version + tenant enforcement
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_wms_task_locked';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'WMS/P7: _wms_task_locked is missing';
  END IF;
  IF v_def NOT LIKE '%wms_task_stale%'
     OR v_def NOT LIKE '%wms_task_version_required%'
     OR v_def NOT LIKE '%_wms_assert_business_access%'
     OR v_def NOT LIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION 'WMS/P7: _wms_task_locked lost a guard (version, tenant or row lock)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'wms_operators'
       AND column_name = 'row_version'
  ) THEN
    RAISE EXCEPTION 'WMS/P7: wms_operators.row_version is missing';
  END IF;

  -- the boards must expose the version the client has to echo back
  FOREACH v_name IN ARRAY ARRAY['wms_labour_queue_view','wms_operator_board_view'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = v_name AND column_name = 'row_version'
    ) THEN
      RAISE EXCEPTION 'WMS/P7: % no longer exposes row_version', v_name;
    END IF;
  END LOOP;

  -- releasing a task must publish the standard availability event
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'wms_release_task';
  IF v_def NOT LIKE '%warehouse.task.available%' THEN
    RAISE EXCEPTION 'WMS/P7: wms_release_task stopped emitting warehouse.task.available';
  END IF;
END $$;

ROLLBACK;

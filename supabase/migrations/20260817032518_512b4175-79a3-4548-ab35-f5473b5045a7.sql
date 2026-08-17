-- INV-SIM 2026-08-17: plate/task optimistic-concurrency conflicts were raised
-- with SQLSTATE 40001 (serialization_failure). The API layer treats 40001 as a
-- retryable conflict, so a stale-version plate call never returned: it looped,
-- left an aborted-but-open transaction holding the plate row, and every later
-- operation on that plate blocked forever on an unbounded FOR UPDATE.
-- Repair: report conflicts as a non-retryable rejection, and bound the row wait.

CREATE OR REPLACE FUNCTION public._wms_lpn_assert_version(_lpn wms_license_plates, _expected_version integer)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
BEGIN
  IF _expected_version IS NULL THEN
    RAISE EXCEPTION 'wms_lpn_version_required' USING ERRCODE = '22023';
  END IF;
  IF _lpn.row_version <> _expected_version THEN
    RAISE EXCEPTION 'wms_lpn_stale' USING ERRCODE = '22023';
  END IF;
END $function$;

DO $mig$
DECLARE
  v_name text;
  v_def  text;
  v_args text;
BEGIN
  -- 1. rewrite every remaining 40001 conflict raise to 22023.
  FOR v_name, v_def IN
    SELECT p.proname, pg_get_functiondef(p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND pg_get_functiondef(p.oid) ~ '''(wms_lpn_stale|wms_task_stale)[^'']*''[^;]*40001'
  LOOP
    EXECUTE regexp_replace(
      v_def,
      '(''(?:wms_lpn_stale|wms_task_stale)[^'']*''[^;]*ERRCODE\s*=\s*)''40001''',
      '\1''22023''',
      'g'
    );
  END LOOP;

  -- 2. bound the row wait on every plate/task mutator so a wedged row fails
  --    fast (55P03) instead of parking a connection indefinitely.
  FOR v_name, v_args IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (p.proname LIKE 'wms_lpn_%' OR p.proname IN (
             '_wms_task_locked','wms_reassign_task','wms_release_task',
             'wms_set_task_priority','wms_set_operator_status','wms_transition_lpn'))
       AND pg_get_functiondef(p.oid) ~* 'FOR UPDATE'
  LOOP
    EXECUTE format('ALTER FUNCTION public.%I(%s) SET lock_timeout TO %L', v_name, v_args, '5s');
  END LOOP;
END $mig$;

-- 3. verify no conflict raise still uses the retryable code.
DO $check$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ')
    INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND pg_get_functiondef(p.oid) ~ '''(wms_lpn_stale|wms_task_stale)[^'']*''[^;]*40001';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'still raising 40001 for a plate/task conflict: %', v_bad;
  END IF;
END $check$;
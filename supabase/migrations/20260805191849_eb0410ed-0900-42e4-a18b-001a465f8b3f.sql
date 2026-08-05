-- Bulk label expansion could never enqueue a print job: the INSERT into
-- public.print_jobs omitted the NOT NULL `transport` column, so every run
-- aborted with 23502 the first time it reached step 3. Single-label prints
-- already use transport='thermal' (device-bound label bytes go to the agent),
-- so the batch path must stamp the same value.
--
-- The patch is applied surgically against the live definition so the rest of
-- the (long) function body cannot drift while fixing two lines.
DO $mig$
DECLARE
  v_def text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE proname = 'expand_label_run'
    AND pronamespace = 'public'::regnamespace;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'expand_label_run not found';
  END IF;

  v_new := replace(
    v_def,
    'hardware_role, media_profile_id, copies, correlation_id, dedupe_key, status,',
    'hardware_role, media_profile_id, copies, correlation_id, dedupe_key, status, transport,'
  );
  v_new := replace(
    v_new,
    '''queued''::public.print_job_status, ''label_run'', r.workflow,',
    '''queued''::public.print_job_status, ''thermal'', ''label_run'', r.workflow,'
  );

  IF v_new = v_def THEN
    RAISE EXCEPTION 'expand_label_run: expected print_jobs insert not found; aborting';
  END IF;
  IF position('dedupe_key, status, transport,' IN v_new) = 0
     OR position('''thermal'', ''label_run''' IN v_new) = 0 THEN
    RAISE EXCEPTION 'expand_label_run: patch did not apply cleanly';
  END IF;

  EXECUTE v_new;
END;
$mig$;
-- Cycle count governance invariants (2026-08-17).
--
-- Origin: a posted cycle count showed an empty approver and its Difference
-- Report still read "a supervisor must approve it". Two defects were behind it:
--   1. the count lifecycle RPCs accepted a NULL actor, which both skipped the
--      SoD evaluation and stamped a blank approver;
--   2. the capture-time tolerance classification was never reconciled with the
--      Inventory decision, so reports read a resolved count as pending.
-- These assertions are structural/behavioural ratchets against both.

-- 1. Structural: every count lifecycle RPC refuses an unidentified actor.
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(p.proname, ', ')
    INTO v_missing
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('physical_count_submit','physical_count_approve',
                       'physical_count_post','physical_count_cancel')
     AND pg_get_functiondef(p.oid) NOT LIKE '%GOV_ACTOR_REQUIRED%';

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION
      'count lifecycle RPC(s) accept a NULL actor (no GOV_ACTOR_REQUIRED guard): %', v_missing;
  END IF;
END $$;

-- 2. Behavioural: a NULL actor is refused, not silently accepted.
DO $$
DECLARE v_id uuid; v_ok boolean := false;
BEGIN
  SELECT id INTO v_id FROM public.physical_counts LIMIT 1;
  IF v_id IS NULL THEN RETURN; END IF;  -- nothing to probe in this database

  BEGIN
    PERFORM public.physical_count_approve(v_id, NULL);
  EXCEPTION
    WHEN insufficient_privilege THEN v_ok := true;   -- 42501 GOV_ACTOR_REQUIRED
    WHEN OTHERS THEN
      -- Any state-machine refusal reached AFTER the actor guard would mean the
      -- guard let a NULL actor through.
      RAISE EXCEPTION 'physical_count_approve(NULL actor) failed for the wrong reason: % / %',
        SQLSTATE, SQLERRM;
  END;

  IF NOT v_ok THEN
    RAISE EXCEPTION 'physical_count_approve accepted a NULL actor';
  END IF;
END $$;

-- 3. Structural: the resolution field exists and is constrained.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='wms_count_lines'
       AND column_name='approval_state'
  ) THEN
    RAISE EXCEPTION 'wms_count_lines.approval_state is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='wms_count_lines_approval_state_check'
  ) THEN
    RAISE EXCEPTION 'approval_state is unconstrained — any string could be stored';
  END IF;
END $$;

-- 4. Structural: the sanctioned read path exposes the resolution, so no client
--    has a reason to read wms_count_lines directly to find out who approved.
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc
   WHERE pronamespace='public'::regnamespace AND proname='get_count_lines';

  IF v_def IS NULL OR v_def NOT LIKE '%approval_state%' OR v_def NOT LIKE '%approval_actor_id%' THEN
    RAISE EXCEPTION 'get_count_lines does not return the approval resolution';
  END IF;
END $$;

-- 5. Behavioural: no posted count session may leave its lines unresolved.
DO $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n
    FROM public.wms_count_lines l
    JOIN public.wms_count_sessions s ON s.id = l.session_id
   WHERE s.state = 'posted'
     AND l.approval_state = 'pending'
     AND NOT EXISTS (
       SELECT 1 FROM public.wms_count_lines r WHERE r.recount_of_line_id = l.id
     );

  IF v_n > 0 THEN
    RAISE EXCEPTION
      '% count line(s) on posted sessions still read as awaiting approval', v_n;
  END IF;
END $$;

-- 6. Behavioural: an approved count never records an approval it cannot
--    attribute, unless it is explicitly marked as a pre-fix backfill.
DO $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n
    FROM public.physical_counts
   WHERE state IN ('approved','posted')
     AND approved_by IS NULL
     AND approved_at > '2026-08-17'::date;   -- everything created after the fix

  IF v_n > 0 THEN
    RAISE EXCEPTION '% count(s) approved after the fix with no recorded approver', v_n;
  END IF;
END $$;

-- 7. Structural: stock still moves only through the Inventory adjustment path.
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc
   WHERE pronamespace='public'::regnamespace AND proname='post_count_session';

  IF v_def ~* 'UPDATE\s+public\.stock_quants' OR v_def ~* 'INSERT\s+INTO\s+public\.stock_movements' THEN
    RAISE EXCEPTION 'post_count_session writes stock directly — it must delegate to Inventory';
  END IF;
END $$;

-- POS Wave · Phase 9 — offline / retry + till-close payment guard.
-- Locks the server contract the terminal now depends on:
--   1. Both recovery seams exist and are SECURITY DEFINER.
--   2. Neither is executable by anon/PUBLIC.
--   3. The close guard trigger is attached to pos_shifts.
--   4. pos_payment_session_commit rejects new money into a closed till, and
--      that check comes AFTER the apply-log replay branch so an offline retry
--      of an already-committed sale still returns its cached envelope.
\set ON_ERROR_STOP on

-- 1) Functions exist and are SECURITY DEFINER.
DO $$
DECLARE fn text; missing text[] := ARRAY[]::text[]; not_definer text[] := ARRAY[]::text[]; d bool;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'pos_register_open_payment_sessions',
    'pos_till_close_blockers',
    'tg_pos_till_close_payment_guard'
  ] LOOP
    SELECT p.prosecdef INTO d FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname=fn LIMIT 1;
    IF d IS NULL THEN missing := array_append(missing, fn);
    ELSIF NOT d THEN not_definer := array_append(not_definer, fn);
    END IF;
  END LOOP;
  IF array_length(missing,1) > 0 THEN
    RAISE EXCEPTION 'Phase 9 routines missing: %', missing;
  END IF;
  IF array_length(not_definer,1) > 0 THEN
    RAISE EXCEPTION 'Phase 9 routines must be SECURITY DEFINER: %', not_definer;
  END IF;
END $$;

-- 2) No anon/PUBLIC EXECUTE.
DO $$
DECLARE leak text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO leak
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public'
    AND p.proname IN ('pos_register_open_payment_sessions','pos_till_close_blockers')
    AND EXISTS (
      SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE a.privilege_type='EXECUTE'
        AND a.grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname='anon')));
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 9 recovery seams executable by anon/PUBLIC: %', leak;
  END IF;
END $$;

-- 3) Close guard trigger attached to pos_shifts.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM pg_trigger
   WHERE tgname='trg_pos_till_close_payment_guard'
     AND tgrelid='public.pos_shifts'::regclass
) THEN 1 ELSE 0 END AS till_close_payment_guard_attached;

-- 4) Commit: shift_closed guard present AND after the apply-log replay branch.
DO $$
DECLARE def text; p_apply int; p_shift int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO def
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='pos_payment_session_commit' LIMIT 1;

  p_apply := position('apply_log' in def);
  p_shift := position('shift_closed' in def);

  IF p_shift = 0 THEN
    RAISE EXCEPTION 'pos_payment_session_commit lost its shift_closed guard';
  END IF;
  IF p_apply = 0 OR p_shift < p_apply THEN
    RAISE EXCEPTION
      'shift_closed check must follow the apply-log replay branch, otherwise an '
      'offline retry of an already-committed sale is rejected instead of '
      'returning its cached receipt envelope (apply_log=%, shift_closed=%)',
      p_apply, p_shift;
  END IF;
END $$;

-- 5) The blockers wrapper must actually consider open payment sessions.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='pos_till_close_blockers'
    AND pg_get_functiondef(p.oid) ILIKE '%open_payment_sessions%'
) THEN 1 ELSE 0 END AS blockers_reports_open_payment_sessions;

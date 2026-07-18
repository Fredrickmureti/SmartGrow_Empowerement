-- Wave 3 · Phase 1 · Structural contract test for the POS Payment Session
-- durable aggregate. Locks the invariants shipped by the Phase 1 migration
-- so a future edit cannot silently drop them:
--
--   1. Three tables exist: pos_payment_sessions, pos_payment_session_tenders,
--      pos_payment_session_apply_log.
--   2. Apply-log uses `session_id` as PRIMARY KEY — the commit idempotency guard.
--   3. All five session RPCs exist AND are SECURITY DEFINER (branch-scope +
--      RLS enforced by the RPC body, not by direct client grants).
--   4. `authenticated` role has NO direct INSERT/UPDATE/DELETE on the session
--      tables — writes flow exclusively through the RPCs.
--   5. FSM trigger + branch-scope trigger are attached on the tender table.
--   6. All five outbox topics are registered in `business_event_topics`.
--
-- The end-to-end auth-required lifecycle simulation (open → tender → commit →
-- apply-log blocks a second commit) requires an authenticated JWT harness and
-- lands in Phase 2 alongside the client integration. This file locks the
-- server contract that phase will depend on.

\set ON_ERROR_STOP on

-- 1) Tables present.
DO $$
DECLARE
  tbl text; missing text[] := ARRAY[]::text[];
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'pos_payment_sessions',
    'pos_payment_session_tenders',
    'pos_payment_session_apply_log'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name = tbl
    ) THEN
      missing := array_append(missing, tbl);
    END IF;
  END LOOP;
  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'Phase 1 tables missing: %', missing;
  END IF;
END $$;

-- 2) Apply-log commit-idempotency: session_id is the PRIMARY KEY.
DO $$
DECLARE pk_cols text;
BEGIN
  SELECT string_agg(a.attname, ',' ORDER BY array_position(i.indkey, a.attnum))
    INTO pk_cols
  FROM pg_index i
  JOIN pg_attribute a
    ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
  WHERE i.indrelid = 'public.pos_payment_session_apply_log'::regclass
    AND i.indisprimary;

  IF pk_cols IS DISTINCT FROM 'session_id' THEN
    RAISE EXCEPTION
      'pos_payment_session_apply_log must have session_id as sole PK (got %). '
      'This PK is the commit idempotency guard — a second commit for the same '
      'session must fail on the PK conflict.', pk_cols;
  END IF;
END $$;

-- 3) All five session RPCs exist AND are SECURITY DEFINER.
DO $$
DECLARE
  fn text; missing text[] := ARRAY[]::text[]; not_definer text[] := ARRAY[]::text[];
  is_definer bool;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'pos_payment_session_open',
    'pos_payment_session_record_tender',
    'pos_payment_session_reverse_tender',
    'pos_payment_session_commit',
    'pos_payment_session_cancel'
  ]
  LOOP
    SELECT p.prosecdef INTO is_definer
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname=fn
     LIMIT 1;
    IF is_definer IS NULL THEN
      missing := array_append(missing, fn);
    ELSIF NOT is_definer THEN
      not_definer := array_append(not_definer, fn);
    END IF;
  END LOOP;
  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'Session RPCs missing: %', missing;
  END IF;
  IF array_length(not_definer, 1) > 0 THEN
    RAISE EXCEPTION 'Session RPCs must be SECURITY DEFINER: %', not_definer;
  END IF;
END $$;

-- 4) authenticated role must NOT have direct INSERT/UPDATE/DELETE on the
--    session tables. All mutation flows through the SECURITY DEFINER RPCs.
DO $$
DECLARE
  tbl text; priv text; leaks text[] := ARRAY[]::text[];
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'pos_payment_sessions',
    'pos_payment_session_tenders',
    'pos_payment_session_apply_log'
  ]
  LOOP
    FOREACH priv IN ARRAY ARRAY['INSERT','UPDATE','DELETE']
    LOOP
      IF has_table_privilege('authenticated', 'public.'||tbl, priv) THEN
        leaks := array_append(leaks, tbl||':'||priv);
      END IF;
    END LOOP;
  END LOOP;
  IF array_length(leaks, 1) > 0 THEN
    RAISE EXCEPTION
      'authenticated role has direct mutation privileges on session tables (%). '
      'The session aggregate is server-owned; writes must flow through the '
      'SECURITY DEFINER RPCs only.', leaks;
  END IF;
END $$;

-- 5) FSM trigger + branch-scope trigger attached on the tender table.
DO $$
DECLARE trig text; missing text[] := ARRAY[]::text[];
BEGIN
  FOREACH trig IN ARRAY ARRAY[
    'zzz_assert_tender_fsm',
    'zzz_assert_pos_branch_caller_access'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgname = trig
         AND tgrelid = 'public.pos_payment_session_tenders'::regclass
    ) THEN
      missing := array_append(missing, trig);
    END IF;
  END LOOP;
  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'Phase 1 triggers missing on pos_payment_session_tenders: %', missing;
  END IF;
END $$;

-- 6) All five outbox topics registered.
DO $$
DECLARE t text; missing text[] := ARRAY[]::text[];
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pos.payment.session.opened',
    'pos.payment.tender.recorded',
    'pos.payment.tender.reversed',
    'pos.payment.session.committed',
    'pos.payment.session.cancelled'
  ]
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.business_event_topics WHERE topic_prefix = t) THEN
      missing := array_append(missing, t);
    END IF;
  END LOOP;
  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'Phase 1 outbox topics missing from business_event_topics: %', missing;
  END IF;
END $$;

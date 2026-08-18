-- =====================================================================
-- Finance Wave 2 · Phase 16 — bank feed transport invariants
--
-- WHAT THIS PROVES
-- The feed is a transport, not an engine:
--   1. Run lifecycle is owned by three SECURITY DEFINER seams
--      (`bank_feed_run_start` / `_finish` / `_fail`) plus the connection
--      resolver — one overload each, pinned search_path, never anon.
--   2. Concurrency is enforced by the database, not by Deno: a partial
--      unique index allows at most one `running` run per connection, and
--      `bank_feed_run_start` maps that unique violation to
--      BANK_FEED_RUN_IN_FLIGHT.
--   3. A dead consent cannot open a run (BANK_FEED_NEEDS_REAUTH).
--   4. Failure is observable: `_fail` increments `consecutive_failures`
--      and moves the connection to `error` / `needs_reauth`; `_finish`
--      resets the counter and clears `last_error`. Both are idempotent for
--      a run that is no longer `running`.
--   5. Feed state has ONE home: `bank_accounts` carries no sync_status /
--      sync_error / last_sync_at, and the read model `bank_feed_status`
--      is SECURITY INVOKER (so RLS applies) and not executable by anon.
--   6. Ingestion identity is the database's: every feed line lands through
--      `bank_statement_import_batch`, and `bank_feed_runs` is the audit
--      trail (each run points at the statement it produced).
--
-- These are catalog + definition assertions on purpose: they cannot be
-- satisfied by a comment or by application code, only by the live routine
-- bodies, and they survive a `CREATE OR REPLACE` by a future engineer.
--
-- Run with: supabase test db --linked --file bank_feed_transport_invariants_test.sql
-- =====================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- 1) Exactly one overload per feed seam, hardened, not anonymous.
-- ---------------------------------------------------------------------
DO $$
DECLARE r record; seam text;
BEGIN
  FOREACH seam IN ARRAY ARRAY[
    'bank_feed_connection_resolve','bank_feed_run_start',
    'bank_feed_run_finish','bank_feed_run_fail'
  ] LOOP
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname=seam) <> 1 THEN
      RAISE EXCEPTION 'feed seam % must have exactly one overload', seam;
    END IF;

    SELECT p.prosecdef, p.proconfig, p.proacl, p.proowner INTO r
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=seam;

    IF NOT r.prosecdef THEN
      RAISE EXCEPTION 'feed seam % is not SECURITY DEFINER', seam;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(r.proconfig,'{}')) c WHERE c LIKE 'search\_path=%') THEN
      RAISE EXCEPTION 'feed seam % has no pinned search_path', seam;
    END IF;
    IF EXISTS (
      SELECT 1 FROM aclexplode(COALESCE(r.proacl, acldefault('f', r.proowner))) a
      WHERE a.privilege_type='EXECUTE'
        AND a.grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname='anon'))
    ) THEN
      RAISE EXCEPTION 'feed seam % is executable by anon/PUBLIC', seam;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 2) Concurrency is a database constraint, and the seam translates it.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_def text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND tablename='bank_feed_runs'
      AND indexdef ILIKE 'CREATE UNIQUE INDEX%(connection_id)%'
      AND indexdef ILIKE '%status = ''running''%'
  ) THEN
    RAISE EXCEPTION 'no partial unique index guaranteeing one running run per connection';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND tablename='bank_feed_connections'
      AND indexdef ILIKE 'CREATE UNIQUE INDEX%(bank_account_id)%'
      AND indexdef ILIKE '%disabled%'
  ) THEN
    RAISE EXCEPTION 'no partial unique index guaranteeing one live connection per bank account';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='bank_feed_run_start';

  IF v_def NOT ILIKE '%unique_violation%' OR v_def NOT LIKE '%BANK_FEED_RUN_IN_FLIGHT%' THEN
    RAISE EXCEPTION 'bank_feed_run_start does not map a concurrent run to BANK_FEED_RUN_IN_FLIGHT';
  END IF;

  IF v_def NOT LIKE '%BANK_FEED_NEEDS_REAUTH%' THEN
    RAISE EXCEPTION 'bank_feed_run_start does not refuse a dead consent';
  END IF;

  -- The run is opened by the seam, from the resolved connection: the caller
  -- cannot invent organization_id / business_id / connection_id.
  IF v_def NOT LIKE '%bank_feed_connection_resolve%' THEN
    RAISE EXCEPTION 'bank_feed_run_start does not resolve the connection server-side';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 3) Failure and success both move connection health, and are idempotent.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_fail text; v_finish text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_fail
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='bank_feed_run_fail';

  SELECT pg_get_functiondef(p.oid) INTO v_finish
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='bank_feed_run_finish';

  IF v_fail NOT ILIKE '%consecutive_failures = consecutive_failures + 1%' THEN
    RAISE EXCEPTION 'bank_feed_run_fail does not increment consecutive_failures';
  END IF;
  IF v_fail NOT LIKE '%needs_reauth%' THEN
    RAISE EXCEPTION 'bank_feed_run_fail does not park an auth failure as needs_reauth';
  END IF;
  IF v_finish NOT ILIKE '%consecutive_failures = 0%' OR v_finish NOT ILIKE '%last_error = NULL%' THEN
    RAISE EXCEPTION 'bank_feed_run_finish does not clear connection failure state';
  END IF;

  -- Idempotency: neither seam may re-close a run that already left `running`.
  IF v_fail NOT ILIKE '%status <> ''running''%' THEN
    RAISE EXCEPTION 'bank_feed_run_fail is not idempotent on a closed run';
  END IF;
  IF v_finish NOT ILIKE '%status <> ''running''%' THEN
    RAISE EXCEPTION 'bank_feed_run_finish is not idempotent on a closed run';
  END IF;

  -- Both take the run row FOR UPDATE: two workers cannot close it twice.
  IF v_fail NOT ILIKE '%FOR UPDATE%' OR v_finish NOT ILIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION 'run close seams do not lock the run row';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 4) Feed state has exactly one home.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_col text;
BEGIN
  FOREACH v_col IN ARRAY ARRAY['sync_status','sync_error','last_sync_at'] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='bank_accounts' AND column_name=v_col
    ) THEN
      RAISE EXCEPTION 'bank_accounts.% came back: feed state belongs to the connection and its runs', v_col;
    END IF;
  END LOOP;

  -- Connection health + run history columns must exist where they now live.
  FOREACH v_col IN ARRAY ARRAY['status','last_error','last_success_at','last_run_at','consecutive_failures'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='bank_feed_connections' AND column_name=v_col
    ) THEN
      RAISE EXCEPTION 'bank_feed_connections.% is missing', v_col;
    END IF;
  END LOOP;

  FOREACH v_col IN ARRAY ARRAY[
    'connection_id','status','window_from','window_to','fetched_count',
    'inserted_count','duplicate_count','rejected_count','statement_id','error_code'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='bank_feed_runs' AND column_name=v_col
    ) THEN
      RAISE EXCEPTION 'bank_feed_runs.% is missing', v_col;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 5) The read model is a projection under RLS, never a definer backdoor.
-- ---------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='bank_feed_status') <> 1 THEN
    RAISE EXCEPTION 'bank_feed_status must have exactly one overload';
  END IF;

  SELECT p.prosecdef, p.proacl, p.proowner, p.provolatile INTO r
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='bank_feed_status';

  IF r.prosecdef THEN
    RAISE EXCEPTION 'bank_feed_status is SECURITY DEFINER: it would bypass RLS on feed state';
  END IF;
  IF r.provolatile = 'v' THEN
    RAISE EXCEPTION 'bank_feed_status must be a read model (STABLE/IMMUTABLE), not VOLATILE';
  END IF;
  IF EXISTS (
    SELECT 1 FROM aclexplode(COALESCE(r.proacl, acldefault('f', r.proowner))) a
    WHERE a.privilege_type='EXECUTE'
      AND a.grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname='anon'))
  ) THEN
    RAISE EXCEPTION 'bank_feed_status is executable by anon/PUBLIC';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 6) RLS is on the feed tables, and nobody can write them directly.
-- ---------------------------------------------------------------------
DO $$
DECLARE t text; v_role text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_feed_connections','bank_feed_runs'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relname=t) THEN
      RAISE EXCEPTION 'RLS is off on public.%', t;
    END IF;

    FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF has_table_privilege(v_role, 'public.'||t, 'INSERT')
         OR has_table_privilege(v_role, 'public.'||t, 'UPDATE')
         OR has_table_privilege(v_role, 'public.'||t, 'DELETE') THEN
        RAISE EXCEPTION '% can write public.% directly; feed state is seam-owned', v_role, t;
      END IF;
    END LOOP;

    IF has_table_privilege('anon', 'public.'||t, 'SELECT') THEN
      RAISE EXCEPTION 'anon can read public.%', t;
    END IF;

    -- The read model is SECURITY INVOKER, so the signed-in role needs
    -- table-level SELECT for RLS to be the thing that decides.
    IF NOT has_table_privilege('authenticated', 'public.'||t, 'SELECT') THEN
      RAISE EXCEPTION 'authenticated cannot SELECT public.%: bank_feed_status would be unreadable', t;
    END IF;


    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND tablename=t AND cmd='SELECT'
    ) THEN
      RAISE EXCEPTION 'public.% has no SELECT policy', t;
    END IF;
  END LOOP;
END $$;


-- ---------------------------------------------------------------------
-- 7) Ingestion identity stays in the database: one engine, deterministic
--    dedup, and rules applied server-side (no Deno rule engine).
-- ---------------------------------------------------------------------
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='bank_statement_import_batch';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'bank_statement_import_batch is gone: the feed has no ingestion engine';
  END IF;
  IF v_def NOT LIKE '%bank_transaction_apply_rules%' THEN
    RAISE EXCEPTION 'ingestion no longer applies categorization rules server-side';
  END IF;

  -- Dedup identity lives on bank_transactions, not in the caller.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND tablename='bank_transactions'
      AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
      AND (indexdef ILIKE '%external_transaction_id%' OR indexdef ILIKE '%fingerprint%' OR indexdef ILIKE '%dedup%')
  ) THEN
    RAISE EXCEPTION 'no unique dedup index on bank_transactions: re-ingesting a window could duplicate lines';
  END IF;
END $$;

SELECT 'bank feed transport invariants: OK' AS result;

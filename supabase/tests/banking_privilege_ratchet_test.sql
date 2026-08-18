-- =====================================================================
-- Banking Wave 1 · Phase 6.4/6.6 — privilege ratchet + cash-position
-- provenance, asserted in SQL.
--
-- WHAT THIS PROVES
-- 1. No banking table is writable by `authenticated`: every write goes
--    through a SECURITY DEFINER seam.
-- 2. No banking table or routine is reachable by `anon`/`PUBLIC`.
-- 3. The journal tables (the posting monopoly) are not writable by anon.
-- 4. Cash position is DERIVED: `bank_account_positions` exists and the
--    orphaned `bank_accounts.current_balance` column stays dead.
--
-- This file is the defence against a future `CREATE OR REPLACE` or
-- `CREATE TABLE` restoring default privileges.
--
-- Run with: supabase test db --linked --file banking_privilege_ratchet_test.sql
-- =====================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- 1) Banking tables: `authenticated` may read only; `anon`/`PUBLIC` nothing.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_leak text;
BEGIN
  SELECT string_agg(format('%s:%s:%s', c.relname, a.grantee::regrole, a.privilege_type), E'\n  ')
    INTO v_leak
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND (c.relname LIKE 'bank\_%' OR c.relname LIKE 'bank\_reconciliation\_%')
    AND (
      (a.grantee = (SELECT oid FROM pg_roles WHERE rolname='authenticated')
        AND a.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE'))
      OR a.grantee = 0
      OR a.grantee = (SELECT oid FROM pg_roles WHERE rolname='anon')
    );

  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'banking table privilege leak:%s  %', E'\n', v_leak;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2) Banking routines: never executable by anon/PUBLIC.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_leak text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, E'\n  ') INTO v_leak
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND (p.proname LIKE 'bank\_%' OR p.proname LIKE '\_bank\_%' OR p.proname LIKE 'reconcile\_bank\_%')
    AND EXISTS (
      SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE a.privilege_type = 'EXECUTE'
        AND a.grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname='anon'))
    );

  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'banking routines executable by anon/PUBLIC:%s  %', E'\n', v_leak;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 3) RLS is enabled on every banking table.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_missing
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r'
    AND c.relname LIKE 'bank\_%'
    AND NOT c.relrowsecurity;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'RLS disabled on banking table(s): %', v_missing;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 4) The posting monopoly: journals are not reachable by anon/PUBLIC.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_leak text;
BEGIN
  SELECT string_agg(format('%s:%s:%s', c.relname, a.grantee::regrole, a.privilege_type), ', ')
    INTO v_leak
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  WHERE n.nspname='public'
    AND c.relname IN ('journal_entries','journal_entry_lines')
    AND a.grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname='anon'));
  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'journal tables reachable by anon/PUBLIC: %', v_leak;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 5) D-7 ratchet: cash position is derived, never stored.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='bank_accounts' AND column_name='current_balance'
  ) THEN
    RAISE EXCEPTION 'D-7 regression: bank_accounts.current_balance is back — a second source of cash truth';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='bank_account_positions'
  ) THEN
    RAISE EXCEPTION 'the canonical cash-position projection is missing';
  END IF;

  -- The projection reads with the caller''s rights so RLS decides visibility.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='bank_account_positions' AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'bank_account_positions must be SECURITY INVOKER (RLS decides visibility)';
  END IF;
END $$;

SELECT 'banking_privilege_ratchet: ok' AS result;

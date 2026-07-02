-- Scanner cockpit Wave 3 — RLS catalog regression.
--
-- Locks the invariants behind the scanner_sessions + scanner_session_pairings
-- tables so a future policy edit cannot silently expose cross-tenant
-- pairings or open direct INSERT/UPDATE/DELETE to authenticated users.
--
-- Static catalog checks (no fixture seeding) so it runs in any DB.
\set ON_ERROR_STOP on

-- ============================================================
-- 1. RLS is enabled on both tables
-- ============================================================
DO $$
DECLARE
  tbl text;
  rls_on boolean;
  missing text[] := ARRAY[]::text[];
BEGIN
  FOREACH tbl IN ARRAY ARRAY['scanner_sessions','scanner_session_pairings']
  LOOP
    SELECT relrowsecurity INTO rls_on
    FROM pg_class
    WHERE oid = ('public.' || tbl)::regclass;
    IF NOT rls_on THEN
      missing := array_append(missing, tbl);
    END IF;
  END LOOP;
  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'RLS not enabled on: %', missing;
  END IF;
END $$;

-- ============================================================
-- 2. RESTRICTIVE "no direct write" policy is present on BOTH tables.
--    This is the gate that forces all writes through SECURITY DEFINER
--    RPCs (create_scanner_session / pos_create_scanner_pairing /
--    pos_claim_scanner_pairing / pos_revoke_scanner_pairing).
-- ============================================================
DO $$
DECLARE
  tbl text;
  pol_count int;
  missing text[] := ARRAY[]::text[];
BEGIN
  FOREACH tbl IN ARRAY ARRAY['scanner_sessions','scanner_session_pairings']
  LOOP
    SELECT count(*) INTO pol_count
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = tbl
      AND permissive = 'RESTRICTIVE'
      AND cmd        = 'ALL';
    IF pol_count = 0 THEN
      missing := array_append(missing, tbl);
    END IF;
  END LOOP;
  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'RESTRICTIVE no-direct-write policy missing on: %', missing;
  END IF;
END $$;

-- ============================================================
-- 3. A SELECT policy exists on scanner_sessions that is NOT public
--    (must reference auth.uid()/created_by/user_roles, never `true`).
-- ============================================================
DO $$
DECLARE
  qual text;
BEGIN
  SELECT qual INTO qual
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename  = 'scanner_sessions'
    AND cmd        = 'SELECT'
    AND permissive = 'PERMISSIVE'
  LIMIT 1;
  IF qual IS NULL THEN
    RAISE EXCEPTION 'No PERMISSIVE SELECT policy on scanner_sessions';
  END IF;
  IF position('auth.uid()' IN qual) = 0 AND position('user_roles' IN qual) = 0 THEN
    RAISE EXCEPTION 'scanner_sessions SELECT policy is not scoped to auth.uid()/user_roles: %', qual;
  END IF;
  IF position('true' IN lower(qual)) = length(qual) - 3 THEN
    RAISE EXCEPTION 'scanner_sessions SELECT policy looks unconditional: %', qual;
  END IF;
END $$;

-- ============================================================
-- 4. The SECURITY DEFINER RPCs that mutate these tables exist and
--    are owned by a privileged role (i.e. NOT executable by anon via
--    arbitrary impersonation — they enforce org-membership internally).
-- ============================================================
DO $$
DECLARE
  fn text;
  missing text[] := ARRAY[]::text[];
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'create_scanner_session',
    'pos_create_scanner_pairing',
    'pos_claim_scanner_pairing',
    'pos_revoke_scanner_pairing'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = fn
        AND p.prosecdef = true
    ) THEN
      missing := array_append(missing, fn);
    END IF;
  END LOOP;
  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'Required SECURITY DEFINER RPC missing: %', missing;
  END IF;
END $$;

-- ============================================================
-- 5. anon role cannot SELECT either table.
-- ============================================================
DO $$
DECLARE
  tbl text;
  bad text[] := ARRAY[]::text[];
BEGIN
  FOREACH tbl IN ARRAY ARRAY['scanner_sessions','scanner_session_pairings']
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND table_name   = tbl
        AND grantee      = 'anon'
        AND privilege_type = 'SELECT'
    ) THEN
      bad := array_append(bad, tbl);
    END IF;
  END LOOP;
  IF array_length(bad, 1) > 0 THEN
    RAISE EXCEPTION 'anon must not have SELECT on: %', bad;
  END IF;
END $$;
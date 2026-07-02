-- POS Stage R12 — RPC defense-in-depth assertions.
-- The R2 migration added `PERFORM public.assert_pos_caller_branch_access(...)`
-- inside the 8 money-handling RPCs so a caller without authority over the
-- register's branch is refused (SQLSTATE 42501) BEFORE any side effect.
--
-- This static catalog test verifies the function bodies still contain the
-- assert call. It does NOT seed fixtures; the runtime behaviour is asserted
-- by the application-level tests. The point here is to fail loudly if a
-- future migration regenerates one of these RPCs without re-including the
-- assert.
\set ON_ERROR_STOP on

DO $$
DECLARE
  fn text;
  body text;
  missing text[] := ARRAY[]::text[];
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'process_pos_transaction',
    'process_pos_void',
    'process_pos_return',
    'pos_add_cash_movement',
    'process_pos_drawer_event',
    'recall_pos_held_transaction',
    'close_pos_shift',
    'verify_cashier_pin'
  ]
  LOOP
    SELECT pg_get_functiondef(p.oid) INTO body
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = fn
    LIMIT 1;
    IF body IS NULL THEN
      missing := array_append(missing, fn || ' (function missing)');
    ELSIF position('assert_pos_caller_branch_access' IN body) = 0 THEN
      missing := array_append(missing, fn || ' (assert missing)');
    END IF;
  END LOOP;
  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'R2 in-RPC defense-in-depth missing: %', missing;
  END IF;
END $$;

-- The assert helper itself must raise SQLSTATE 42501 (insufficient_privilege).
-- Verified by inspecting the function body for the RAISE clause.
DO $$
DECLARE body text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO body
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'assert_pos_caller_branch_access'
  LIMIT 1;
  IF body IS NULL THEN
    RAISE EXCEPTION 'assert_pos_caller_branch_access is missing';
  END IF;
  IF position('42501' IN body) = 0 THEN
    RAISE EXCEPTION 'assert_pos_caller_branch_access must RAISE SQLSTATE 42501';
  END IF;
END $$;

-- POS Stage R12 — RLS policy presence assertions.
-- Verifies that the SELECT policies rewritten in the R8 migration are still
-- attached to every POS table whose visibility must respect branch_id. This
-- is a static catalog check (no fixture seeding) so it runs in any DB.
\set ON_ERROR_STOP on

DO $$
DECLARE
  tbl text;
  pol_count int;
  missing text[] := ARRAY[]::text[];
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'pos_floors','pos_kitchen_orders','pos_manager_overrides',
    'pos_table_bookings','pos_table_sessions','pos_waitlist',
    'pos_cashier_registers','pos_drawer_events','pos_sessions'
  ]
  LOOP
    SELECT count(*) INTO pol_count
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = tbl
      AND cmd = 'SELECT';
    IF pol_count = 0 THEN
      missing := array_append(missing, tbl);
    END IF;
  END LOOP;
  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'R8 SELECT policy missing on: %', missing;
  END IF;
END $$;

-- Every R8-covered table must have RLS enabled.
DO $$
DECLARE
  tbl text;
  rls_on boolean;
  missing text[] := ARRAY[]::text[];
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'pos_floors','pos_kitchen_orders','pos_manager_overrides',
    'pos_table_bookings','pos_table_sessions','pos_waitlist',
    'pos_cashier_registers','pos_drawer_events','pos_sessions',
    'pos_held_transactions'
  ]
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

-- The `can_access_branch` helper used by every R8 policy must exist.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'can_access_branch'
) THEN 1 ELSE 0 END AS can_access_branch_present;

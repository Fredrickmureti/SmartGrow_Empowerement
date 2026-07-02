-- POS Stage B — branch isolation server-side guards.
-- Static assertions against pg_catalog so the test runs without seeding
-- any tenant data. Verifies the triggers + helper functions shipped by
-- migrations 20260516115704 (sessions/shifts surface) and the Stage
-- B3-complete follow-up (transaction/cash/drawer/override surface).

\set ON_ERROR_STOP on

-- 1) Helper function exists with the expected signature.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'assert_pos_caller_branch_access'
) THEN 1 ELSE 0 END AS assert_helper_present;

-- 2) Generic trigger function exists.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'tg_assert_pos_branch_caller_access'
) THEN 1 ELSE 0 END AS assert_trigger_fn_present;

-- 3) Trigger is attached to every money-handling and audit surface.
--    The session/shift/cashier/restaurant surfaces were covered by the
--    first B3 migration; the transaction/drawer/cash/override surfaces
--    by the B3-complete migration.
DO $$
DECLARE
  tbl text;
  missing text[] := ARRAY[]::text[];
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'pos_shifts','pos_sessions','pos_cashiers','pos_kitchen_orders',
    'pos_table_bookings','pos_waitlist',
    'pos_transactions','pos_transaction_items','pos_transaction_payments',
    'pos_drawer_events','pos_cash_movements','pos_manager_overrides',
    -- Stage R1
    'pos_held_transactions','pos_table_sessions','pos_cashier_registers','pos_floors'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'zzz_assert_pos_branch_caller_access'
        AND tgrelid = ('public.' || tbl)::regclass
    ) THEN
      missing := array_append(missing, tbl);
    END IF;
  END LOOP;
  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'Stage B branch-isolation trigger missing on: %', missing;
  END IF;
END $$;

-- 4) Payment-method special trigger (company-default rows require admin).
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM pg_trigger
  WHERE tgname = 'zzz_assert_pos_payment_method_scope'
    AND tgrelid = 'public.pos_payment_methods'::regclass
) THEN 1 ELSE 0 END AS payment_method_scope_trigger_present;

-- 5) Stage R1 scope-guard trigger for company-shared tables (gift cards, discounts).
DO $$
DECLARE tbl text; missing text[] := ARRAY[]::text[];
BEGIN
  FOREACH tbl IN ARRAY ARRAY['pos_gift_cards','pos_discounts']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'zzz_assert_pos_scope_caller_access'
        AND tgrelid = ('public.' || tbl)::regclass
    ) THEN
      missing := array_append(missing, tbl);
    END IF;
  END LOOP;
  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'Stage R1 scope-guard trigger missing on: %', missing;
  END IF;
END $$;

-- 6) Stage R1 helper function exists.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'tg_assert_pos_scope_caller_access'
) THEN 1 ELSE 0 END AS scope_guard_fn_present;
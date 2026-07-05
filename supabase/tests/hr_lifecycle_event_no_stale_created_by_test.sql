-- HR Stabilization drift guard.
--
-- public.employee_lifecycle_events uses `actor_user_id` for the actor
-- identity and has never had a `created_by` column. A trigger function
-- referencing NEW.created_by against that table breaks every INSERT into
-- employee_lifecycle_events, cascading into every HR write that emits a
-- lifecycle event (contract create/activate/expire, hire, termination,
-- leave, reinstate).
--
-- Root cause of the 2026-07-05 contract-creation outage:
-- tg_hr_event_propose_loan_skip declared
--   v_actor uuid := COALESCE(auth.uid(), NEW.created_by);
-- which failed at plan time with:
--   ERROR: record "new" has no field "created_by"
--
-- This guard fails CI if any AFTER/BEFORE trigger on
-- employee_lifecycle_events reintroduces a stale NEW.<col> reference for a
-- column that does not exist on that table. It mirrors the pattern used by
-- employee_contracts_no_stale_field_refs_test.sql.

BEGIN;
SELECT plan(2);

-- (1) The specific column that caused the outage must never reappear in any
-- function attached to employee_lifecycle_events as a trigger.
SELECT is(
  (
    SELECT count(*)::int
      FROM pg_trigger t
      JOIN pg_proc  p ON p.oid = t.tgfoid
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT t.tgisinternal
       AND n.nspname = 'public'
       AND c.relname = 'employee_lifecycle_events'
       AND pg_get_functiondef(p.oid) ~* 'NEW\.created_by'
  ),
  0,
  'No trigger on public.employee_lifecycle_events may reference NEW.created_by. Use NEW.actor_user_id — the table has no created_by column.'
);

-- (2) The current shape of employee_lifecycle_events is stable: actor_user_id
-- exists, created_by does not. If either invariant flips, adjust every
-- trigger + this test in the same migration.
SELECT is(
  (
    SELECT (
      EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='employee_lifecycle_events'
                 AND column_name='actor_user_id')
      AND NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='employee_lifecycle_events'
                 AND column_name='created_by')
    )
  ),
  true,
  'employee_lifecycle_events must expose actor_user_id and must not expose created_by.'
);

SELECT * FROM finish();
ROLLBACK;

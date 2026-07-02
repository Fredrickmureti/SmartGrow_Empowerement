-- HR Stabilization — Regression 2 drift guard.
--
-- `public.employee_contracts` does not (and historically did not) have a
-- `work_schedule_id` column. The schedule lives in `working_schedule`.
-- An earlier function set referenced `v_c.work_schedule_id` where `v_c` was
-- a row of `employee_contracts`; that broke `create_employee_with_identifiers`
-- via the employee insert trigger chain with
--   ERROR: record "v_c" has no field "work_schedule_id"
--
-- This guard fails CI if any future migration reintroduces the drift.
-- It only fires when the column truly is absent from `employee_contracts`,
-- so legitimate references to `employees.work_schedule_id` (used by the
-- attendance functions) remain unaffected.

BEGIN;
SELECT plan(1);

SELECT is(
  (
    SELECT count(*)::int
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND pg_get_functiondef(p.oid) ~*
          '(employee_contracts[^;]{0,400}work_schedule_id|v_c\.work_schedule_id)'
      AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name   = 'employee_contracts'
          AND c.column_name  = 'work_schedule_id'
      )
  ),
  0,
  'No public function may reference employee_contracts.work_schedule_id while the column does not exist. Use employee_contracts.working_schedule, or add a real FK column in the same migration.'
);

SELECT * FROM finish();
ROLLBACK;

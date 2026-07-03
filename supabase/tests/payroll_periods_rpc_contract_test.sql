-- Payroll Periods RPC contract (Phase 0).
--
-- Pins the surface area the UI depends on so a future migration cannot
-- silently drop or rename these RPCs and re-introduce the HTTP 400 that
-- motivated the Schedules audit.
BEGIN;
SELECT plan(4);

SELECT has_function('public','lock_timesheets_for_payroll',
  ARRAY['uuid'],
  'lock_timesheets_for_payroll(_payroll_period_id uuid) must exist');

SELECT has_function('public','unlock_timesheets_for_payroll',
  ARRAY['uuid','text'],
  'unlock_timesheets_for_payroll(_payroll_period_id uuid, _reason text) must exist');

SELECT has_function('public','generate_payroll_periods',
  ARRAY['uuid','uuid','integer','text'],
  'generate_payroll_periods keeps (org, business, year, period_type) arity');

SELECT has_table('public','payroll_periods',
  'payroll_periods aggregate table must exist');

SELECT * FROM finish();
ROLLBACK;
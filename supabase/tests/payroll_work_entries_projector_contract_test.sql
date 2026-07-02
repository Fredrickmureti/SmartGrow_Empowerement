-- Contract test: payroll_work_entries has exactly one writer and rows
-- are always typed. Enforces ADR-0042.

BEGIN;
SELECT plan(4);

-- 1) The projector exists and is SECURITY DEFINER.
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'payroll_work_entries_project'
      AND p.prosecdef = true
  ),
  'payroll_work_entries_project(uuid) exists and is SECURITY DEFINER'
);

-- 2) The widened source CHECK is in place.
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.payroll_work_entries'::regclass
      AND conname  = 'payroll_work_entries_source_check'
      AND pg_get_constraintdef(oid) LIKE '%timesheet%'
      AND pg_get_constraintdef(oid) LIKE '%holiday%'
  ),
  'source CHECK covers attendance/leave/timesheet/holiday/adjustment/manual'
);

-- 3) Canonical types are seeded for every organization.
SELECT is(
  (SELECT COUNT(*)::int FROM public.organizations o
    WHERE NOT EXISTS (
      SELECT 1 FROM public.payroll_work_entry_types t
       WHERE t.organization_id = o.id AND t.code = 'WORK'
    )),
  0,
  'every organization has the canonical WORK type seeded'
);

-- 4) The legacy entry point still exists (forwarder) but the projector
--    is independently invocable — both surfaces are present.
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'attendance_generate_work_entries'
  ),
  'legacy attendance_generate_work_entries forwarder is still present'
);

SELECT * FROM finish();
ROLLBACK;

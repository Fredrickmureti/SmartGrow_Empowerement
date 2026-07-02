
-- ============================================================
-- Wave 1: Add branch_id to HR tables for branch isolation
-- ============================================================

-- Helper: add branch_id column + FK + index, no backfill yet
DO $$
DECLARE
  t text;
  hr_tables text[] := ARRAY[
    'employee_contracts',
    'attendance',
    'leave_requests',
    'timesheets',
    'timesheet_submissions',
    'work_schedules',
    'departments',
    'employee_documents',
    'employee_onboarding'
  ];
BEGIN
  FOREACH t IN ARRAY hr_tables LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL',
      t
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I (business_id, branch_id)',
      'idx_' || t || '_business_branch', t
    );
  END LOOP;
END $$;

-- Backfill branch_id from related employee where applicable
UPDATE public.employee_contracts c
   SET branch_id = e.branch_id
  FROM public.employees e
 WHERE c.employee_id = e.id
   AND c.branch_id IS NULL
   AND e.branch_id IS NOT NULL;

UPDATE public.attendance a
   SET branch_id = e.branch_id
  FROM public.employees e
 WHERE a.employee_id = e.id
   AND a.branch_id IS NULL
   AND e.branch_id IS NOT NULL;

UPDATE public.leave_requests lr
   SET branch_id = e.branch_id
  FROM public.employees e
 WHERE lr.employee_id = e.id
   AND lr.branch_id IS NULL
   AND e.branch_id IS NOT NULL;

UPDATE public.timesheets ts
   SET branch_id = e.branch_id
  FROM public.employees e
 WHERE ts.employee_id = e.id
   AND ts.branch_id IS NULL
   AND e.branch_id IS NOT NULL;

UPDATE public.timesheet_submissions tss
   SET branch_id = e.branch_id
  FROM public.employees e
 WHERE tss.employee_id = e.id
   AND tss.branch_id IS NULL
   AND e.branch_id IS NOT NULL;

UPDATE public.employee_documents ed
   SET branch_id = e.branch_id
  FROM public.employees e
 WHERE ed.employee_id = e.id
   AND ed.branch_id IS NULL
   AND e.branch_id IS NOT NULL;

UPDATE public.employee_onboarding eo
   SET branch_id = e.branch_id
  FROM public.employees e
 WHERE eo.employee_id = e.id
   AND eo.branch_id IS NULL
   AND e.branch_id IS NOT NULL;

-- departments and work_schedules have no direct employee FK; leave NULL = company-wide

-- ============================================================
-- Wave 1: Unique constraint — a user can be linked to at most ONE
-- employee per business (NULL user_id remains unconstrained).
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS employees_user_business_unique
  ON public.employees (user_id, business_id)
  WHERE user_id IS NOT NULL;

ALTER TABLE public.employee_contracts
ADD COLUMN IF NOT EXISTS time_tracking_source text NOT NULL DEFAULT 'attendance'
CHECK (time_tracking_source IN ('attendance', 'timesheets', 'manual'));

COMMENT ON COLUMN public.employee_contracts.time_tracking_source IS
  'Which system feeds payroll work entries for this contract: attendance | timesheets | manual.';
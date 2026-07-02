
ALTER TABLE public.payroll_run_issues
  ADD COLUMN IF NOT EXISTS dismissed_at timestamptz,
  ADD COLUMN IF NOT EXISTS dismissed_by uuid,
  ADD COLUMN IF NOT EXISTS dismissed_reason text;

CREATE INDEX IF NOT EXISTS idx_payroll_run_issues_open_per_run
  ON public.payroll_run_issues (payroll_run_id)
  WHERE resolved_at IS NULL AND dismissed_at IS NULL;

CREATE OR REPLACE FUNCTION public.payroll_run_issues_block_blocker_dismiss()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.dismissed_at IS NOT NULL
     AND NEW.severity::text = 'blocker'
     AND OLD.dismissed_at IS NULL
  THEN
    RAISE EXCEPTION 'Blocker-severity diagnostics cannot be dismissed; resolve at source'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.dismissed_at IS NOT NULL AND (NEW.dismissed_reason IS NULL OR length(trim(NEW.dismissed_reason)) < 10) THEN
    RAISE EXCEPTION 'dismissed_reason must be at least 10 characters'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payroll_run_issues_block_blocker_dismiss ON public.payroll_run_issues;
CREATE TRIGGER trg_payroll_run_issues_block_blocker_dismiss
  BEFORE UPDATE ON public.payroll_run_issues
  FOR EACH ROW
  EXECUTE FUNCTION public.payroll_run_issues_block_blocker_dismiss();

DROP VIEW IF EXISTS public.payroll_diagnostics;
CREATE VIEW public.payroll_diagnostics AS
SELECT i.id,
    i.organization_id,
    i.business_id,
    i.payroll_run_id,
    i.employee_id,
    i.code,
    i.severity,
    i.message,
    i.details,
    i.created_at,
    i.resolved_at,
    i.resolved_by,
    r.payroll_number,
    r.pay_period_start,
    r.pay_period_end,
    r.status AS run_status,
    e.first_name AS employee_first_name,
    e.last_name AS employee_last_name,
    e.employee_number,
    i.dismissed_at,
    i.dismissed_by,
    i.dismissed_reason
   FROM public.payroll_run_issues i
     LEFT JOIN public.payroll_runs r ON r.id = i.payroll_run_id
     LEFT JOIN public.employees e ON e.id = i.employee_id;

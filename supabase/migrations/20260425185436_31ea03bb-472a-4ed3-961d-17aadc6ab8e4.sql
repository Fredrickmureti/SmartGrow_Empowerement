-- Backfill installed apps for tenants with existing data
INSERT INTO public.organization_installed_apps (organization_id, app_id, is_active, lifecycle_state, installed_at)
SELECT DISTINCT organization_id, 'employees', true, 'active'::app_lifecycle_state, now()
FROM (
  SELECT organization_id FROM public.employees WHERE organization_id IS NOT NULL
  UNION SELECT organization_id FROM public.employee_contracts WHERE organization_id IS NOT NULL
  UNION SELECT organization_id FROM public.payroll_runs WHERE organization_id IS NOT NULL
  UNION SELECT organization_id FROM public.payslips WHERE organization_id IS NOT NULL
) src
ON CONFLICT (organization_id, app_id) DO NOTHING;

INSERT INTO public.organization_installed_apps (organization_id, app_id, is_active, lifecycle_state, installed_at)
SELECT DISTINCT organization_id, 'payroll', true, 'active'::app_lifecycle_state, now()
FROM (
  SELECT organization_id FROM public.payroll_runs WHERE organization_id IS NOT NULL
  UNION SELECT organization_id FROM public.payslips WHERE organization_id IS NOT NULL
  UNION SELECT organization_id FROM public.payroll_periods WHERE organization_id IS NOT NULL
  UNION SELECT organization_id FROM public.payroll_remittances WHERE organization_id IS NOT NULL
  UNION SELECT organization_id FROM public.payroll_statutory_rules WHERE organization_id IS NOT NULL
) src
ON CONFLICT (organization_id, app_id) DO NOTHING;

INSERT INTO public.organization_installed_apps (organization_id, app_id, is_active, lifecycle_state, installed_at)
SELECT DISTINCT organization_id, 'time-off', true, 'active'::app_lifecycle_state, now()
FROM (
  SELECT organization_id FROM public.leave_requests WHERE organization_id IS NOT NULL
  UNION SELECT organization_id FROM public.leave_allocations WHERE organization_id IS NOT NULL
  UNION SELECT organization_id FROM public.leave_types WHERE organization_id IS NOT NULL
) src
ON CONFLICT (organization_id, app_id) DO NOTHING;

INSERT INTO public.organization_installed_apps (organization_id, app_id, is_active, lifecycle_state, installed_at)
SELECT DISTINCT organization_id, 'attendance', true, 'active'::app_lifecycle_state, now()
FROM (
  SELECT organization_id FROM public.attendance WHERE organization_id IS NOT NULL
) src
ON CONFLICT (organization_id, app_id) DO NOTHING;

-- Write-guard triggers
DROP TRIGGER IF EXISTS trg_employees_app_installed ON public.employees;
CREATE TRIGGER trg_employees_app_installed
  BEFORE INSERT OR UPDATE OR DELETE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.assert_app_installed_for_write('employees');

DROP TRIGGER IF EXISTS trg_employee_contracts_app_installed ON public.employee_contracts;
CREATE TRIGGER trg_employee_contracts_app_installed
  BEFORE INSERT OR UPDATE OR DELETE ON public.employee_contracts
  FOR EACH ROW EXECUTE FUNCTION public.assert_app_installed_for_write('employees');

DROP TRIGGER IF EXISTS trg_payroll_periods_app_installed ON public.payroll_periods;
CREATE TRIGGER trg_payroll_periods_app_installed
  BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_periods
  FOR EACH ROW EXECUTE FUNCTION public.assert_app_installed_for_write('payroll');

DROP TRIGGER IF EXISTS trg_payroll_remittances_app_installed ON public.payroll_remittances;
CREATE TRIGGER trg_payroll_remittances_app_installed
  BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_remittances
  FOR EACH ROW EXECUTE FUNCTION public.assert_app_installed_for_write('payroll');

DROP TRIGGER IF EXISTS trg_payroll_statutory_rules_app_installed ON public.payroll_statutory_rules;
CREATE TRIGGER trg_payroll_statutory_rules_app_installed
  BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_statutory_rules
  FOR EACH ROW EXECUTE FUNCTION public.assert_app_installed_for_write('payroll');

DROP TRIGGER IF EXISTS trg_leave_types_app_installed ON public.leave_types;
CREATE TRIGGER trg_leave_types_app_installed
  BEFORE INSERT OR UPDATE OR DELETE ON public.leave_types
  FOR EACH ROW EXECUTE FUNCTION public.assert_app_installed_for_write('time-off');

DROP TRIGGER IF EXISTS trg_work_schedules_app_installed ON public.work_schedules;
CREATE TRIGGER trg_work_schedules_app_installed
  BEFORE INSERT OR UPDATE OR DELETE ON public.work_schedules
  FOR EACH ROW EXECUTE FUNCTION public.assert_app_installed_for_write('attendance');

-- Drop unused legacy RPC
DROP FUNCTION IF EXISTS public.request_app_notification(text, uuid);

-- Helper: single source of truth for "payslip visible to its employee".
CREATE OR REPLACE FUNCTION public.payslip_visible_to_employee(_payslip_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.payslips p
    JOIN public.employees e ON e.id = p.employee_id
    WHERE p.id = _payslip_id
      AND e.user_id = auth.uid()
      AND p.status IN ('approved','posted','paid')
  )
$$;

GRANT EXECUTE ON FUNCTION public.payslip_visible_to_employee(uuid) TO authenticated, service_role;

-- Rewrite payslips self-branch: employees only see finalized payslips.
DROP POLICY IF EXISTS payslips_select_branch_scoped ON public.payslips;
CREATE POLICY payslips_select_branch_scoped
  ON public.payslips
  FOR SELECT
  USING (
    (
      employee_id IN (
        SELECT employees.id FROM public.employees
        WHERE employees.user_id = auth.uid()
      )
      AND status IN ('approved','posted','paid')
    )
    OR (
      business_id IS NOT NULL
      AND user_can_access_business(auth.uid(), business_id)
      AND user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'read')
    )
  );

-- Re-align payslip_lines self-select to call the helper.
DROP POLICY IF EXISTS payslip_lines_self_select ON public.payslip_lines;
CREATE POLICY payslip_lines_self_select
  ON public.payslip_lines
  FOR SELECT
  USING (public.payslip_visible_to_employee(payslip_id));

-- New: let employees read the payroll-run header for runs containing a payslip
-- they're allowed to see. No other payroll_runs access is granted.
DROP POLICY IF EXISTS payroll_runs_self_select ON public.payroll_runs;
CREATE POLICY payroll_runs_self_select
  ON public.payroll_runs
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.payslips p
      WHERE p.payroll_run_id = payroll_runs.id
        AND public.payslip_visible_to_employee(p.id)
    )
  );
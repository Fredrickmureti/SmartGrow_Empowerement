-- Fix: portal visibility must follow payroll_run.status (approval lifecycle),
-- not payslips.status (which only tracks payment: pending -> paid).
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
      LEFT JOIN public.payroll_runs r ON r.id = p.payroll_run_id
     WHERE p.id = _payslip_id
       AND e.user_id = auth.uid()
       AND COALESCE(r.status, '') IN ('approved','posted','closed','paid')
  )
$$;

-- Rewrite the self-branch of payslips_select_branch_scoped to use the same
-- run-status predicate (so summary and detail visibility agree).
DROP POLICY IF EXISTS payslips_select_branch_scoped ON public.payslips;

CREATE POLICY payslips_select_branch_scoped
ON public.payslips
FOR SELECT
TO authenticated
USING (
  -- Admin / payroll-permission branch: unchanged
  public.user_has_module_permission(auth.uid(), organization_id, 'payroll', 'read')
  OR
  -- Self branch: employee sees their own payslip only when the parent
  -- payroll run is approved / posted / closed / paid.
  EXISTS (
    SELECT 1
      FROM public.employees e
      LEFT JOIN public.payroll_runs r ON r.id = payslips.payroll_run_id
     WHERE e.id = payslips.employee_id
       AND e.user_id = auth.uid()
       AND COALESCE(r.status, '') IN ('approved','posted','closed','paid')
  )
);

-- payslip_lines_self_select and payroll_runs_self_select already delegate
-- to payslip_visible_to_employee, so they pick up the new rule automatically.

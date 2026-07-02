-- =====================================================================
-- Fix: infinite recursion in payroll_runs RLS
--
-- Cycle previously present:
--   payroll_runs.payroll_runs_self_select
--     -> SELECT payslips
--        -> payslips.payslips_select_branch_scoped self-branch
--           -> SELECT payroll_runs   ← recurses
--
-- Both helpers are SECURITY DEFINER and read tables directly. We then
-- rewrite the SELECT policies on payslips and payroll_runs to call the
-- helpers instead of joining tables under caller RLS, breaking the cycle.
-- =====================================================================

-- 1) Payslip-level visibility helper (unchanged contract, hardened body).
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
  );
$$;

GRANT EXECUTE ON FUNCTION public.payslip_visible_to_employee(uuid)
  TO authenticated, service_role;

-- 2) Run-level visibility helper. Returns true iff the caller is linked
--    to an employee on this run AND the run is in a finalized state.
--    Lives entirely inside SECURITY DEFINER so it never re-enters RLS.
CREATE OR REPLACE FUNCTION public.payroll_run_visible_to_employee(_run_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.payroll_runs r
      JOIN public.payslips p ON p.payroll_run_id = r.id
      JOIN public.employees e ON e.id = p.employee_id
     WHERE r.id = _run_id
       AND e.user_id = auth.uid()
       AND COALESCE(r.status, '') IN ('approved','posted','closed','paid')
  );
$$;

GRANT EXECUTE ON FUNCTION public.payroll_run_visible_to_employee(uuid)
  TO authenticated, service_role;

-- 3) Rewrite payslips self-branch to use the helper (no table joins in policy).
DROP POLICY IF EXISTS payslips_select_branch_scoped ON public.payslips;

CREATE POLICY payslips_select_branch_scoped
  ON public.payslips
  FOR SELECT
  TO authenticated
  USING (
    -- Admin / payroll-permission branch (unchanged behavior).
    public.user_has_module_permission(auth.uid(), organization_id, 'payroll', 'read')
    OR
    -- Self branch: delegate to SECURITY DEFINER helper so the policy
    -- evaluator does not recurse into payroll_runs RLS.
    public.payslip_visible_to_employee(payslips.id)
  );

-- 4) Rewrite payroll_runs self-select to use the run-level helper directly.
--    No subquery against payslips under RLS, so the policy graph is acyclic.
DROP POLICY IF EXISTS payroll_runs_self_select ON public.payroll_runs;

CREATE POLICY payroll_runs_self_select
  ON public.payroll_runs
  FOR SELECT
  TO authenticated
  USING (
    public.payroll_run_visible_to_employee(payroll_runs.id)
  );

-- 5) payslip_lines_self_select already delegates to payslip_visible_to_employee
--    (verified live). Leaving it untouched keeps detail visibility aligned.
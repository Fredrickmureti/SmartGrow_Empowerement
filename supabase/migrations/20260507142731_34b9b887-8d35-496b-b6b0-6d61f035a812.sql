
-- Payroll Stage 5 — Salary privacy guard.
-- The permission system is module-based; we model "viewSalaryDetails" as
-- read on a virtual module 'payroll_salary'. The helper short-circuits
-- for the employee themselves and for org admins/owners.

CREATE OR REPLACE FUNCTION public.payroll_can_see_amounts(
  _user_id uuid,
  _business_id uuid,
  _employee_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
BEGIN
  IF _user_id IS NULL THEN RETURN false; END IF;

  -- 1. Employee always sees their own amounts
  IF EXISTS (
    SELECT 1 FROM public.employees e
     WHERE e.id = _employee_id AND e.user_id = _user_id
  ) THEN
    RETURN true;
  END IF;

  IF _business_id IS NULL THEN RETURN false; END IF;

  SELECT b.organization_id INTO v_org
    FROM public.businesses b
   WHERE b.id = _business_id;
  IF v_org IS NULL THEN RETURN false; END IF;

  -- 2. Org owners/admins / super admins
  IF EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = _user_id
       AND ur.organization_id = v_org
       AND ur.role IN ('owner','admin','super_admin')
  ) THEN
    RETURN true;
  END IF;

  -- 3. Explicit grant via permission group: read on virtual module 'payroll_salary'
  RETURN public.user_has_module_permission(_user_id, v_org, _business_id, 'payroll_salary', 'read');
END;
$$;

COMMENT ON FUNCTION public.payroll_can_see_amounts(uuid, uuid, uuid) IS
'Returns true when a user is entitled to see actual money amounts on a
 payslip (own payslip, org admin/owner, or read-grant on virtual module
 payroll_salary). Drives v_payslips_redacted and frontend redaction.';

DROP VIEW IF EXISTS public.v_payslips_redacted;
CREATE VIEW public.v_payslips_redacted
WITH (security_invoker = true)
AS
SELECT
  p.id,
  p.payroll_run_id,
  p.employee_id,
  p.organization_id,
  p.business_id,
  p.branch_id,
  p.status,
  p.created_at,
  p.updated_at,
  CASE WHEN public.payroll_can_see_amounts(auth.uid(), p.business_id, p.employee_id)
       THEN p.gross_pay END        AS gross_pay,
  CASE WHEN public.payroll_can_see_amounts(auth.uid(), p.business_id, p.employee_id)
       THEN p.net_pay END          AS net_pay,
  CASE WHEN public.payroll_can_see_amounts(auth.uid(), p.business_id, p.employee_id)
       THEN p.basic_salary END     AS basic_salary,
  CASE WHEN public.payroll_can_see_amounts(auth.uid(), p.business_id, p.employee_id)
       THEN p.total_deductions END AS total_deductions,
  CASE WHEN public.payroll_can_see_amounts(auth.uid(), p.business_id, p.employee_id)
       THEN p.other_deductions END AS other_deductions,
  CASE WHEN public.payroll_can_see_amounts(auth.uid(), p.business_id, p.employee_id)
       THEN p.unpaid_leave_days END AS unpaid_leave_days,
  CASE WHEN public.payroll_can_see_amounts(auth.uid(), p.business_id, p.employee_id)
       THEN p.leave_deduction END  AS leave_deduction
FROM public.payslips p;

GRANT SELECT ON public.v_payslips_redacted TO authenticated;

COMMENT ON VIEW public.v_payslips_redacted IS
'Salary-privacy view of public.payslips. Exposes identifying / status
 columns to anyone who can read the underlying row via RLS, but nulls
 every monetary column unless payroll_can_see_amounts() returns true.';

REVOKE ALL ON FUNCTION public.payroll_employee_monthly_breakdown(integer, uuid, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_employee_monthly_breakdown(integer, uuid, text[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.payroll_employee_monthly_breakdown(integer, uuid, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_employee_monthly_breakdown(integer, uuid, text[]) TO service_role;
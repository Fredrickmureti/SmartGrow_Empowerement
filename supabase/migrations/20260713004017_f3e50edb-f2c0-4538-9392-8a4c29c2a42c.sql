
GRANT EXECUTE ON FUNCTION public.payroll_employee_ytd_rollup(integer, uuid) TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.payroll_employee_monthly_breakdown(integer, uuid, text[]) TO authenticated, service_role, anon;

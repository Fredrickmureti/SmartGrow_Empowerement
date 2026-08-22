REVOKE EXECUTE ON FUNCTION public.get_budget_variance_report(uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_period_budget_variance(uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.budget_fiscal_months(uuid, integer) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_budget_variance(uuid, uuid, uuid[], numeric[], date, uuid) FROM anon, PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_budget_variance_report(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_period_budget_variance(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.budget_fiscal_months(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.check_budget_variance(uuid, uuid, uuid[], numeric[], date, uuid) TO authenticated, service_role;
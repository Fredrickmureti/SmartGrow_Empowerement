REVOKE ALL ON FUNCTION public.get_consolidated_statement_lines(uuid, date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_consolidated_statement_totals(uuid, date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.consolidation_cta_reconciliation(uuid, date, date) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_consolidated_statement_lines(uuid, date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_consolidated_statement_totals(uuid, date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.consolidation_cta_reconciliation(uuid, date, date) TO authenticated, service_role;
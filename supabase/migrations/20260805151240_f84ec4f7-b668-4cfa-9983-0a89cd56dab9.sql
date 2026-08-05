REVOKE EXECUTE ON FUNCTION public.gs1_ai_table() FROM anon;
REVOKE EXECUTE ON FUNCTION public.identity_code_candidates(text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.parse_gs1_element_string(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.gs1_ai_table() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.identity_code_candidates(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.parse_gs1_element_string(text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.is_ap_control_account(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.is_ap_control_account(uuid) TO authenticated, service_role;

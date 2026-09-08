REVOKE ALL ON FUNCTION public.is_org_administrator(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_org_administrator(uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.wms_effective_replen_rule(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_effective_replen_rule(uuid, uuid, uuid) TO authenticated, service_role;
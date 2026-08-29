-- user_pins is intentionally policy-less (deny-all through the Data API).
-- PIN verification happens through security-definer functions / server code only.
REVOKE ALL ON public.user_pins FROM anon, authenticated;
GRANT ALL ON public.user_pins TO service_role;
COMMENT ON TABLE public.user_pins IS 'PIN credentials. RLS enabled with no policies on purpose: deny-all via Data API; access only through security-definer functions and service_role.';

-- Internal helper functions must not be callable by anonymous visitors.
REVOKE EXECUTE ON FUNCTION public.get_user_organizations(uuid) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, uuid, public.app_role) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.is_org_member(uuid, uuid) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.is_org_manager(uuid, uuid) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated, public;

GRANT EXECUTE ON FUNCTION public.get_user_organizations(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, uuid, public.app_role) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_org_member(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_org_manager(uuid, uuid) TO authenticated, service_role;
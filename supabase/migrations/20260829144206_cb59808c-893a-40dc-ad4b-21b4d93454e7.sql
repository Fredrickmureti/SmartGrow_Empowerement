-- Supabase default privileges grant EXECUTE on new public functions to
-- anon/authenticated; revoke explicitly for the security-sensitive ones.
REVOKE EXECUTE ON FUNCTION public.bootstrap_super_admin(text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.verify_pin_unauthenticated(uuid, text) FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.set_user_pin(text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.verify_user_pin(text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.disable_user_pin() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_user_session_data(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_last_org_id(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_org_admin_or_owner(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.user_has_module_permission(uuid, uuid, text, text) FROM anon;

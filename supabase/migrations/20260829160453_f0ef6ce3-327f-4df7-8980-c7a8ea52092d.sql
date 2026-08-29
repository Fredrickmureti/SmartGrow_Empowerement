REVOKE ALL ON FUNCTION public.verify_pin_full(text, text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.verify_pin_unauthenticated(uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_pin_full(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.verify_pin_unauthenticated(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.has_user_pin() FROM anon;
REVOKE ALL ON FUNCTION public.bootstrap_super_admin(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bootstrap_super_admin(text) TO service_role;
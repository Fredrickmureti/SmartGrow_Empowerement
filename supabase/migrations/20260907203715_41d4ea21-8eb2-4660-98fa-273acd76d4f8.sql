REVOKE ALL ON public.signup_cleanup_log FROM anon, authenticated;
GRANT ALL ON public.signup_cleanup_log TO service_role;
DROP POLICY IF EXISTS "signup_cleanup_log service role only" ON public.signup_cleanup_log;
CREATE POLICY "signup_cleanup_log service role only"
  ON public.signup_cleanup_log FOR ALL TO service_role
  USING (true) WITH CHECK (true);

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
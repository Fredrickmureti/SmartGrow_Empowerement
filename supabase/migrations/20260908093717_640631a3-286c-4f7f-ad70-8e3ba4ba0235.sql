REVOKE ALL ON FUNCTION public.accounts_assert_deactivatable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accounts_assert_deactivatable() FROM anon;
REVOKE ALL ON FUNCTION public.accounts_assert_deactivatable() FROM authenticated;
-- Rollback:
-- GRANT EXECUTE ON FUNCTION public.accounts_assert_deactivatable() TO authenticated;

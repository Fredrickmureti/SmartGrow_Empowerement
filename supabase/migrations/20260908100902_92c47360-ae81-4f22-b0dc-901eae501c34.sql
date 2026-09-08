REVOKE ALL ON FUNCTION public.accounts_assert_deactivatable() FROM PUBLIC, anon, authenticated;

-- Rollback:
-- GRANT EXECUTE ON FUNCTION public.accounts_assert_deactivatable() TO authenticated;

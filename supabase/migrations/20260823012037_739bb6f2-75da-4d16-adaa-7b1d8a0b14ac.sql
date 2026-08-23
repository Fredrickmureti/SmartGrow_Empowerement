REVOKE ALL ON FUNCTION public._jel_sync_analytics() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._analytic_account_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._analytic_account_delete_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.post_expense_gl(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.analytic_balances(uuid, date, date, uuid) FROM PUBLIC, anon;
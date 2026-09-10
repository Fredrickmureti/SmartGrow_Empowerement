CREATE OR REPLACE FUNCTION public._assert_expense_account_postable(p_account_id uuid)
RETURNS void
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public._assert_expense_account_postable(p_account_id, 'expense account');
$$;

REVOKE ALL ON FUNCTION public._assert_expense_account_postable(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._assert_expense_account_postable(uuid) TO authenticated, service_role;
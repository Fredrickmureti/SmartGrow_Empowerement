-- Wave 6 / Step 2: Remove legacy duplicate RLS policies on public.accounts.
-- Both legacy and v2 policies are restrictive, but the duplication is an
-- attack-surface smell. The v2 policies (accounts_*_perm_v2) add the
-- finance.manage_coa permission gate on top of the financials module
-- permission. Keep v2; drop legacy. SELECT policy is unchanged.
DROP POLICY IF EXISTS accounts_insert_per_business ON public.accounts;
DROP POLICY IF EXISTS accounts_update_per_business ON public.accounts;
DROP POLICY IF EXISTS accounts_delete_per_business ON public.accounts;
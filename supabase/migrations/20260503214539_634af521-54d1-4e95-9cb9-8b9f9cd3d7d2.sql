-- Phase 6 — Chart of Accounts: business-level permission gate
-- COA is a business-level construct shared across branches. Branch users
-- may read it but only users with `finance.manage_coa` at business scope
-- (or org-level admin/owner/accountant via has_finance_permission) may
-- INSERT/UPDATE/DELETE. Defense in depth: RLS write policies + an
-- explicit assert function callable from any future RPC.

-- 1. Helper: assert caller can manage COA for a given business.
CREATE OR REPLACE FUNCTION public.assert_can_manage_coa(_business_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _business_id IS NULL THEN
    RAISE EXCEPTION 'Business context required to manage Chart of Accounts'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.has_finance_permission(auth.uid(), 'finance.manage_coa', _business_id) THEN
    RAISE EXCEPTION 'INSUFFICIENT_PRIVILEGE_COA: Chart of Accounts is managed at the business level. The current user lacks the finance.manage_coa permission.'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.assert_can_manage_coa(uuid) TO authenticated;

-- 2. Tighten accounts write policies. Keep SELECT permissive (any
--    business member can read the COA), but require finance.manage_coa
--    for INSERT / UPDATE / DELETE in addition to module permission.
DROP POLICY IF EXISTS "accounts_insert_perm" ON public.accounts;
DROP POLICY IF EXISTS "accounts_update_perm" ON public.accounts;
DROP POLICY IF EXISTS "accounts_delete_perm" ON public.accounts;

CREATE POLICY "accounts_insert_perm_v2" ON public.accounts
  FOR INSERT TO authenticated
  WITH CHECK (
    public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'create')
    AND public.has_finance_permission(auth.uid(), 'finance.manage_coa', business_id)
  );

CREATE POLICY "accounts_update_perm_v2" ON public.accounts
  FOR UPDATE TO authenticated
  USING (
    public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'write')
    AND public.has_finance_permission(auth.uid(), 'finance.manage_coa', business_id)
  );

CREATE POLICY "accounts_delete_perm_v2" ON public.accounts
  FOR DELETE TO authenticated
  USING (
    public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'delete')
    AND public.has_finance_permission(auth.uid(), 'finance.manage_coa', business_id)
    AND is_system = false
  );

-- 3. Same gate for account_default_mappings (the Apply-Defaults flow).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='account_default_mappings') THEN
    EXECUTE 'DROP POLICY IF EXISTS "account_default_mappings_write" ON public.account_default_mappings';
    EXECUTE $POL$
      CREATE POLICY "account_default_mappings_write" ON public.account_default_mappings
        FOR ALL TO authenticated
        USING (public.has_finance_permission(auth.uid(), 'finance.manage_coa', business_id))
        WITH CHECK (public.has_finance_permission(auth.uid(), 'finance.manage_coa', business_id))
    $POL$;
  END IF;
END $$;
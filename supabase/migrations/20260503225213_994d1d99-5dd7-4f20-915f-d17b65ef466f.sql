-- Phase 11 — Banking: finance.manage_bank_accounts permission + tightened RLS

-- 1. Extend has_finance_permission with finance.manage_bank_accounts
CREATE OR REPLACE FUNCTION public.has_finance_permission(
  _user_id    uuid,
  _perm       text,
  _business_id uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH ctx AS (
    SELECT
      EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = _user_id
          AND ur.is_active = true
          AND ur.role IN ('super_admin','owner','admin','accountant')
          AND (_business_id IS NULL OR ur.organization_id IN (
            SELECT organization_id FROM public.businesses WHERE id = _business_id
          ))
      ) AS is_acct
  )
  SELECT CASE
    WHEN _perm IN (
      'finance.view_consolidated','finance.manage_je','finance.void_je',
      'finance.reconcile_bank','finance.export_reports',
      'finance.manage_settings','finance.manage_coa','finance.manage_periods',
      'finance.manage_budgets','finance.manage_assets',
      'finance.manage_bank_accounts'
    ) THEN (SELECT is_acct FROM ctx)
    ELSE false
  END;
$$;
GRANT EXECUTE ON FUNCTION public.has_finance_permission(uuid,text,uuid) TO authenticated;

-- 2. assert_can_manage_bank_accounts helper
CREATE OR REPLACE FUNCTION public.assert_can_manage_bank_accounts(_business_id uuid)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF _business_id IS NULL THEN
    RAISE EXCEPTION 'INSUFFICIENT_PRIVILEGE_BANK_MANAGE: business_id required.'
      USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_finance_permission(auth.uid(), 'finance.manage_bank_accounts', _business_id) THEN
    RAISE EXCEPTION 'INSUFFICIENT_PRIVILEGE_BANK_MANAGE: Bank accounts are managed at the business level. The current user lacks finance.manage_bank_accounts.'
      USING ERRCODE = '42501';
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.assert_can_manage_bank_accounts(uuid) TO authenticated;

COMMENT ON FUNCTION public.assert_can_manage_bank_accounts(uuid) IS
  'Phase 11 — raises INSUFFICIENT_PRIVILEGE_BANK_MANAGE when caller lacks finance.manage_bank_accounts for the supplied business.';

-- 3. Tighten bank_accounts write RLS — replace *_perm with *_perm_v3 requiring finance.manage_bank_accounts
DROP POLICY IF EXISTS bank_accounts_insert_perm ON public.bank_accounts;
DROP POLICY IF EXISTS bank_accounts_insert_perm_v3 ON public.bank_accounts;
CREATE POLICY bank_accounts_insert_perm_v3 ON public.bank_accounts
FOR INSERT TO authenticated
WITH CHECK (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'financials','write')
  AND public.has_finance_permission(auth.uid(), 'finance.manage_bank_accounts', business_id)
  AND (branch_id IS NULL
       OR user_can_access_branch(auth.uid(), branch_id)
       OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

DROP POLICY IF EXISTS bank_accounts_update_perm ON public.bank_accounts;
DROP POLICY IF EXISTS bank_accounts_update_perm_v3 ON public.bank_accounts;
CREATE POLICY bank_accounts_update_perm_v3 ON public.bank_accounts
FOR UPDATE TO authenticated
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'financials','write')
  AND public.has_finance_permission(auth.uid(), 'finance.manage_bank_accounts', business_id)
  AND (branch_id IS NULL
       OR user_can_access_branch(auth.uid(), branch_id)
       OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
)
WITH CHECK (
  user_can_access_business(auth.uid(), business_id)
  AND public.has_finance_permission(auth.uid(), 'finance.manage_bank_accounts', business_id)
  AND (branch_id IS NULL
       OR user_can_access_branch(auth.uid(), branch_id)
       OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

DROP POLICY IF EXISTS bank_accounts_delete_perm ON public.bank_accounts;
DROP POLICY IF EXISTS bank_accounts_delete_perm_v3 ON public.bank_accounts;
CREATE POLICY bank_accounts_delete_perm_v3 ON public.bank_accounts
FOR DELETE TO authenticated
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'financials','delete')
  AND public.has_finance_permission(auth.uid(), 'finance.manage_bank_accounts', business_id)
  AND (branch_id IS NULL
       OR user_can_access_branch(auth.uid(), branch_id)
       OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

-- 4. Tighten bank_accounts SELECT policy to also reaffirm branch-scope rule (idempotent rebuild)
DROP POLICY IF EXISTS bank_accounts_select_perm ON public.bank_accounts;
DROP POLICY IF EXISTS bank_accounts_select_perm_v3 ON public.bank_accounts;
CREATE POLICY bank_accounts_select_perm_v3 ON public.bank_accounts
FOR SELECT TO authenticated
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'financials','read')
  AND (branch_id IS NULL
       OR user_can_access_branch(auth.uid(), branch_id)
       OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);


-- 1. Stronger access helper: org owner/admin OR platform admin OR explicit business access
CREATE OR REPLACE FUNCTION public.user_can_access_business(_user_id uuid, _business_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.is_platform_admin(_user_id)
    OR EXISTS (
      SELECT 1 FROM public.user_business_access
      WHERE user_id = _user_id AND business_id = _business_id
    )
    OR EXISTS (
      SELECT 1
      FROM public.businesses b
      JOIN public.user_roles ur
        ON ur.organization_id = b.organization_id
       AND ur.user_id = _user_id
       AND ur.is_active = true
       AND ur.role IN ('owner','admin','super_admin')
      WHERE b.id = _business_id
    );
$$;

-- 2. businesses — replace org-only policies with per-business
DROP POLICY IF EXISTS "Users can view businesses in their organizations" ON public.businesses;
DROP POLICY IF EXISTS "Users can update businesses in their organizations" ON public.businesses;
DROP POLICY IF EXISTS "Users can delete businesses in their organizations" ON public.businesses;
-- Keep INSERT as-is (creating a new business needs org membership; UBA row is added by RPC).

CREATE POLICY "businesses_select_per_business" ON public.businesses
FOR SELECT TO authenticated
USING (public.user_can_access_business(auth.uid(), id));

CREATE POLICY "businesses_update_per_business" ON public.businesses
FOR UPDATE TO authenticated
USING (
  has_role(auth.uid(), organization_id, 'owner')
  OR has_role(auth.uid(), organization_id, 'admin')
  OR is_platform_admin(auth.uid())
);

CREATE POLICY "businesses_delete_per_business" ON public.businesses
FOR DELETE TO authenticated
USING (
  has_role(auth.uid(), organization_id, 'owner')
  OR is_platform_admin(auth.uid())
);

-- 3. branches — per-business
DROP POLICY IF EXISTS "Users can view branches in their organizations" ON public.branches;
DROP POLICY IF EXISTS "Users can update branches in their organizations" ON public.branches;
DROP POLICY IF EXISTS "Users can delete branches in their organizations" ON public.branches;
DROP POLICY IF EXISTS "Users can create branches in their organizations" ON public.branches;

CREATE POLICY "branches_select_per_business" ON public.branches
FOR SELECT TO authenticated
USING (public.user_can_access_business(auth.uid(), business_id));

CREATE POLICY "branches_insert_per_business" ON public.branches
FOR INSERT TO authenticated
WITH CHECK (
  (has_role(auth.uid(), organization_id, 'owner')
   OR has_role(auth.uid(), organization_id, 'admin')
   OR is_platform_admin(auth.uid()))
  AND public.user_can_access_business(auth.uid(), business_id)
);

CREATE POLICY "branches_update_per_business" ON public.branches
FOR UPDATE TO authenticated
USING (
  (has_role(auth.uid(), organization_id, 'owner')
   OR has_role(auth.uid(), organization_id, 'admin')
   OR is_platform_admin(auth.uid()))
  AND public.user_can_access_business(auth.uid(), business_id)
);

CREATE POLICY "branches_delete_per_business" ON public.branches
FOR DELETE TO authenticated
USING (
  has_role(auth.uid(), organization_id, 'owner')
  OR is_platform_admin(auth.uid())
);

-- 4. fiscal_periods — per-business (drop legacy permissive policies)
DROP POLICY IF EXISTS "Users can view fiscal periods in their organization" ON public.fiscal_periods;
DROP POLICY IF EXISTS "Users can create fiscal periods in their organization" ON public.fiscal_periods;
DROP POLICY IF EXISTS "Users can update fiscal periods in their organization" ON public.fiscal_periods;
DROP POLICY IF EXISTS "Users can delete fiscal periods in their organization" ON public.fiscal_periods;
DROP POLICY IF EXISTS fiscal_periods_select_perm ON public.fiscal_periods;
DROP POLICY IF EXISTS fiscal_periods_insert_perm ON public.fiscal_periods;
DROP POLICY IF EXISTS fiscal_periods_update_perm ON public.fiscal_periods;
DROP POLICY IF EXISTS fiscal_periods_delete_perm ON public.fiscal_periods;

CREATE POLICY "fiscal_periods_select_per_business" ON public.fiscal_periods
FOR SELECT TO authenticated
USING (
  public.user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, 'financials', 'read')
);

CREATE POLICY "fiscal_periods_insert_per_business" ON public.fiscal_periods
FOR INSERT TO authenticated
WITH CHECK (
  public.user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, 'financials', 'create')
);

CREATE POLICY "fiscal_periods_update_per_business" ON public.fiscal_periods
FOR UPDATE TO authenticated
USING (
  public.user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, 'financials', 'write')
);

CREATE POLICY "fiscal_periods_delete_per_business" ON public.fiscal_periods
FOR DELETE TO authenticated
USING (
  public.user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, 'financials', 'delete')
);

-- 5. accounts (CoA) — per-business + financials perm
DROP POLICY IF EXISTS accounts_select_perm ON public.accounts;
DROP POLICY IF EXISTS accounts_insert_perm ON public.accounts;
DROP POLICY IF EXISTS accounts_update_perm ON public.accounts;
DROP POLICY IF EXISTS accounts_delete_perm ON public.accounts;

CREATE POLICY "accounts_select_per_business" ON public.accounts
FOR SELECT TO authenticated
USING (
  public.user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, 'financials', 'read')
);

CREATE POLICY "accounts_insert_per_business" ON public.accounts
FOR INSERT TO authenticated
WITH CHECK (
  public.user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, 'financials', 'create')
);

CREATE POLICY "accounts_update_per_business" ON public.accounts
FOR UPDATE TO authenticated
USING (
  public.user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, 'financials', 'write')
);

CREATE POLICY "accounts_delete_per_business" ON public.accounts
FOR DELETE TO authenticated
USING (
  public.user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, 'financials', 'delete')
  AND is_system = false
);

-- 6. Org-creation quota (stop unlimited bypass of plan limits)
DROP POLICY IF EXISTS "Authenticated users can create organizations" ON public.organizations;

CREATE POLICY "Authenticated users can create up to 5 organizations" ON public.organizations
FOR INSERT TO authenticated
WITH CHECK (
  is_platform_admin(auth.uid())
  OR (
    SELECT COUNT(*) FROM public.organizations
    WHERE owner_user_id = auth.uid()
  ) < 5
);

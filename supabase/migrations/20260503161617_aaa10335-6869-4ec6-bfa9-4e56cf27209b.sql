
-- ============================================================================
-- 1. Branch-access helper
-- ============================================================================
CREATE OR REPLACE FUNCTION public.user_can_access_branch(_user_id uuid, _branch_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- NULL branch = company-shared/legacy row → always visible to anyone with business access
  SELECT _branch_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.user_branch_assignments
        WHERE user_id = _user_id AND branch_id = _branch_id
      )
      OR -- HQ user: no branch assignments at all in the row's business → see everything
         NOT EXISTS (
           SELECT 1
           FROM public.user_branch_assignments uba
           JOIN public.branches b ON b.id = uba.branch_id
           WHERE uba.user_id = _user_id
             AND b.business_id = (SELECT business_id FROM public.branches WHERE id = _branch_id)
         );
$$;

GRANT EXECUTE ON FUNCTION public.user_can_access_branch(uuid, uuid) TO authenticated, anon;

-- ============================================================================
-- 2. Tighten policies on branch-bearing tables: ADD branch arm to existing v2 policies
--    (bills, bill_payments, purchase_orders, vendor_pricelists already have business arm)
-- ============================================================================

-- bills
DROP POLICY IF EXISTS bills_select_v2 ON public.bills;
CREATE POLICY bills_select_v2 ON public.bills FOR SELECT
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_can_access_branch(auth.uid(), branch_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'read')
);
DROP POLICY IF EXISTS bills_update_v2 ON public.bills;
CREATE POLICY bills_update_v2 ON public.bills FOR UPDATE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_can_access_branch(auth.uid(), branch_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'write')
);
DROP POLICY IF EXISTS bills_delete_v2 ON public.bills;
CREATE POLICY bills_delete_v2 ON public.bills FOR DELETE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_can_access_branch(auth.uid(), branch_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'delete')
);

-- bill_payments
DROP POLICY IF EXISTS bill_payments_select_v2 ON public.bill_payments;
CREATE POLICY bill_payments_select_v2 ON public.bill_payments FOR SELECT
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_can_access_branch(auth.uid(), branch_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'read')
);
DROP POLICY IF EXISTS bill_payments_update_v2 ON public.bill_payments;
CREATE POLICY bill_payments_update_v2 ON public.bill_payments FOR UPDATE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_can_access_branch(auth.uid(), branch_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'write')
);
DROP POLICY IF EXISTS bill_payments_delete_v2 ON public.bill_payments;
CREATE POLICY bill_payments_delete_v2 ON public.bill_payments FOR DELETE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_can_access_branch(auth.uid(), branch_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'delete')
);

-- purchase_orders
DROP POLICY IF EXISTS purchase_orders_select_v2 ON public.purchase_orders;
CREATE POLICY purchase_orders_select_v2 ON public.purchase_orders FOR SELECT
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_can_access_branch(auth.uid(), branch_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'read')
);
DROP POLICY IF EXISTS purchase_orders_update_v2 ON public.purchase_orders;
CREATE POLICY purchase_orders_update_v2 ON public.purchase_orders FOR UPDATE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_can_access_branch(auth.uid(), branch_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'write')
);
DROP POLICY IF EXISTS purchase_orders_delete_v2 ON public.purchase_orders;
CREATE POLICY purchase_orders_delete_v2 ON public.purchase_orders FOR DELETE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_can_access_branch(auth.uid(), branch_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'delete')
);

-- vendor_pricelists
DROP POLICY IF EXISTS vendor_pricelists_select_v2 ON public.vendor_pricelists;
CREATE POLICY vendor_pricelists_select_v2 ON public.vendor_pricelists FOR SELECT
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_can_access_branch(auth.uid(), branch_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'read')
);
DROP POLICY IF EXISTS vendor_pricelists_update_v2 ON public.vendor_pricelists;
CREATE POLICY vendor_pricelists_update_v2 ON public.vendor_pricelists FOR UPDATE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_can_access_branch(auth.uid(), branch_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'write')
);
DROP POLICY IF EXISTS vendor_pricelists_delete_v2 ON public.vendor_pricelists;
CREATE POLICY vendor_pricelists_delete_v2 ON public.vendor_pricelists FOR DELETE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_can_access_branch(auth.uid(), branch_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'delete')
);

-- ============================================================================
-- 3. Tables missing business arm entirely — replace org-only perm policies
--    with full (business + branch + permission) policies.
-- ============================================================================

-- purchase_returns
DROP POLICY IF EXISTS purchase_returns_select_perm ON public.purchase_returns;
DROP POLICY IF EXISTS purchase_returns_update_perm ON public.purchase_returns;
DROP POLICY IF EXISTS purchase_returns_delete_perm ON public.purchase_returns;
CREATE POLICY purchase_returns_select_v2 ON public.purchase_returns FOR SELECT
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_can_access_branch(auth.uid(), branch_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'read')
);
CREATE POLICY purchase_returns_update_v2 ON public.purchase_returns FOR UPDATE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_can_access_branch(auth.uid(), branch_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'write')
);
CREATE POLICY purchase_returns_delete_v2 ON public.purchase_returns FOR DELETE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_can_access_branch(auth.uid(), branch_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'delete')
);

-- vendor_credit_notes
DROP POLICY IF EXISTS vcn_select_perm ON public.vendor_credit_notes;
DROP POLICY IF EXISTS vcn_update_perm ON public.vendor_credit_notes;
DROP POLICY IF EXISTS vcn_delete_perm ON public.vendor_credit_notes;
CREATE POLICY vcn_select_v2 ON public.vendor_credit_notes FOR SELECT
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_can_access_branch(auth.uid(), branch_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'read')
);
CREATE POLICY vcn_update_v2 ON public.vendor_credit_notes FOR UPDATE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_can_access_branch(auth.uid(), branch_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'write')
);
CREATE POLICY vcn_delete_v2 ON public.vendor_credit_notes FOR DELETE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_can_access_branch(auth.uid(), branch_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'delete')
);

-- rfqs
DROP POLICY IF EXISTS rfqs_select_perm ON public.rfqs;
DROP POLICY IF EXISTS rfqs_update_perm ON public.rfqs;
DROP POLICY IF EXISTS rfqs_delete_perm ON public.rfqs;
DROP POLICY IF EXISTS rfqs_select ON public.rfqs;
DROP POLICY IF EXISTS rfqs_update ON public.rfqs;
DROP POLICY IF EXISTS rfqs_delete ON public.rfqs;
CREATE POLICY rfqs_select_v2 ON public.rfqs FOR SELECT
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_can_access_branch(auth.uid(), branch_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'read')
);
CREATE POLICY rfqs_update_v2 ON public.rfqs FOR UPDATE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_can_access_branch(auth.uid(), branch_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'write')
);
CREATE POLICY rfqs_delete_v2 ON public.rfqs FOR DELETE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_can_access_branch(auth.uid(), branch_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'delete')
);

-- expenses (no branch_id column → only add business arm)
DROP POLICY IF EXISTS expenses_select_perm ON public.expenses;
DROP POLICY IF EXISTS expenses_update_perm ON public.expenses;
DROP POLICY IF EXISTS expenses_delete_perm ON public.expenses;
CREATE POLICY expenses_select_v2 ON public.expenses FOR SELECT
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'read')
);
CREATE POLICY expenses_update_v2 ON public.expenses FOR UPDATE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'write')
);
CREATE POLICY expenses_delete_v2 ON public.expenses FOR DELETE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'delete')
);

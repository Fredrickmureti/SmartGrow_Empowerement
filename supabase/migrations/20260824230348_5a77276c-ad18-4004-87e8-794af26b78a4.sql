DROP POLICY IF EXISTS crm_leads_select_v2 ON public.crm_leads;
CREATE POLICY crm_leads_select_v2 ON public.crm_leads FOR SELECT
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'read')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

DROP POLICY IF EXISTS crm_leads_insert_v2 ON public.crm_leads;
CREATE POLICY crm_leads_insert_v2 ON public.crm_leads FOR INSERT
WITH CHECK (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'create')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

DROP POLICY IF EXISTS crm_leads_update_v2 ON public.crm_leads;
CREATE POLICY crm_leads_update_v2 ON public.crm_leads FOR UPDATE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'write')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
)
WITH CHECK (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'write')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

DROP POLICY IF EXISTS crm_leads_delete_v2 ON public.crm_leads;
CREATE POLICY crm_leads_delete_v2 ON public.crm_leads FOR DELETE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'delete')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);
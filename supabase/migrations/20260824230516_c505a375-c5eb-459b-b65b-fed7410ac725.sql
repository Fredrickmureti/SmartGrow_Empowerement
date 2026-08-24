DROP POLICY IF EXISTS crm_activities_select_v2 ON public.crm_activities;
CREATE POLICY crm_activities_select_v2 ON public.crm_activities FOR SELECT
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'read')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

DROP POLICY IF EXISTS crm_activities_insert_v2 ON public.crm_activities;
CREATE POLICY crm_activities_insert_v2 ON public.crm_activities FOR INSERT
WITH CHECK (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'create')
  AND EXISTS (
    SELECT 1 FROM public.crm_leads l
     WHERE l.id = crm_activities.lead_id
       AND l.business_id = crm_activities.business_id
       AND l.organization_id = crm_activities.organization_id
       AND (l.branch_id IS NULL OR user_can_access_branch(auth.uid(), l.branch_id)
            OR has_finance_permission(auth.uid(), 'finance.view_consolidated', l.business_id))
  )
);

DROP POLICY IF EXISTS crm_activities_update_v2 ON public.crm_activities;
CREATE POLICY crm_activities_update_v2 ON public.crm_activities FOR UPDATE
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

DROP POLICY IF EXISTS crm_activities_delete_v2 ON public.crm_activities;
CREATE POLICY crm_activities_delete_v2 ON public.crm_activities FOR DELETE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'delete')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

DROP POLICY IF EXISTS crm_stages_select_v2 ON public.crm_stages;
CREATE POLICY crm_stages_select_v2 ON public.crm_stages FOR SELECT
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'read')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

DROP POLICY IF EXISTS crm_stages_insert_v2 ON public.crm_stages;
CREATE POLICY crm_stages_insert_v2 ON public.crm_stages FOR INSERT
WITH CHECK (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'create')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

DROP POLICY IF EXISTS crm_stages_update_v2 ON public.crm_stages;
CREATE POLICY crm_stages_update_v2 ON public.crm_stages FOR UPDATE
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

DROP POLICY IF EXISTS crm_stages_delete_v2 ON public.crm_stages;
CREATE POLICY crm_stages_delete_v2 ON public.crm_stages FOR DELETE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'delete')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

DROP POLICY IF EXISTS crm_lost_reasons_select_v2 ON public.crm_lost_reasons;
CREATE POLICY crm_lost_reasons_select_v2 ON public.crm_lost_reasons FOR SELECT
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'read')
  AND (branch_id IS NULL OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

DROP POLICY IF EXISTS crm_lost_reasons_write_v2 ON public.crm_lost_reasons;
CREATE POLICY crm_lost_reasons_write_v2 ON public.crm_lost_reasons FOR ALL
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
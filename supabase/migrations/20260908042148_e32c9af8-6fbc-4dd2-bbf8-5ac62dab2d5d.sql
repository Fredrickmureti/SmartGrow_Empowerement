DROP POLICY IF EXISTS journal_entry_lines_select_v3 ON public.journal_entry_lines;
DROP POLICY IF EXISTS journal_entry_lines_insert_v3 ON public.journal_entry_lines;
DROP POLICY IF EXISTS journal_entry_lines_update_v3 ON public.journal_entry_lines;
DROP POLICY IF EXISTS journal_entry_lines_delete_v3 ON public.journal_entry_lines;

CREATE POLICY journal_entry_lines_select_v4 ON public.journal_entry_lines
FOR SELECT TO authenticated
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'read')
  AND (branch_id IS NULL
       OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

CREATE POLICY journal_entry_lines_insert_v4 ON public.journal_entry_lines
FOR INSERT TO authenticated
WITH CHECK (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'create')
  AND (branch_id IS NULL
       OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

CREATE POLICY journal_entry_lines_update_v4 ON public.journal_entry_lines
FOR UPDATE TO authenticated
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'write')
  AND (branch_id IS NULL
       OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

CREATE POLICY journal_entry_lines_delete_v4 ON public.journal_entry_lines
FOR DELETE TO authenticated
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'delete')
  AND (branch_id IS NULL
       OR user_can_access_branch(auth.uid(), branch_id)
       OR has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);
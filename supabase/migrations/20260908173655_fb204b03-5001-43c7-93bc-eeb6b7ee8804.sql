DROP POLICY IF EXISTS mf_groups_insert ON public.mf_groups;
CREATE POLICY mf_groups_insert ON public.mf_groups
  FOR INSERT TO authenticated
  WITH CHECK (mf_can_scoped(business_id, branch_id, 'clients', 'create', loan_officer_id));

DROP POLICY IF EXISTS mf_groups_update ON public.mf_groups;
CREATE POLICY mf_groups_update ON public.mf_groups
  FOR UPDATE TO authenticated
  USING (mf_can_scoped(business_id, branch_id, 'clients', 'write', loan_officer_id))
  WITH CHECK (mf_can_scoped(business_id, branch_id, 'clients', 'write', loan_officer_id));

DROP POLICY IF EXISTS mf_groups_delete ON public.mf_groups;
CREATE POLICY mf_groups_delete ON public.mf_groups
  FOR DELETE TO authenticated
  USING (mf_can_scoped(business_id, branch_id, 'clients', 'delete', loan_officer_id));
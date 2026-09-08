DROP POLICY IF EXISTS mf_group_members_insert ON public.mf_group_members;
CREATE POLICY mf_group_members_insert ON public.mf_group_members
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.mf_groups g
     WHERE g.id = mf_group_members.group_id
       AND mf_can_scoped(g.business_id, g.branch_id, 'clients', 'create', g.loan_officer_id)));

DROP POLICY IF EXISTS mf_group_members_update ON public.mf_group_members;
CREATE POLICY mf_group_members_update ON public.mf_group_members
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.mf_groups g
     WHERE g.id = mf_group_members.group_id
       AND mf_can_scoped(g.business_id, g.branch_id, 'clients', 'write', g.loan_officer_id)))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.mf_groups g
     WHERE g.id = mf_group_members.group_id
       AND mf_can_scoped(g.business_id, g.branch_id, 'clients', 'write', g.loan_officer_id)));

DROP POLICY IF EXISTS mf_group_members_delete ON public.mf_group_members;
CREATE POLICY mf_group_members_delete ON public.mf_group_members
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.mf_groups g
     WHERE g.id = mf_group_members.group_id
       AND mf_can_scoped(g.business_id, g.branch_id, 'clients', 'delete', g.loan_officer_id)));
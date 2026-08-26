-- B1-2: membership writes must also require access to the group's parent company.
DROP POLICY IF EXISTS consolidation_group_members_write ON public.consolidation_group_members;

CREATE POLICY consolidation_group_members_write
ON public.consolidation_group_members
FOR ALL
TO authenticated
USING (
  user_can_access_business(auth.uid(), business_id)
  AND EXISTS (
    SELECT 1 FROM public.consolidation_groups g
    WHERE g.id = consolidation_group_members.group_id
      AND user_can_access_business(auth.uid(), g.parent_business_id)
  )
  AND (
    has_org_role(auth.uid(), organization_id, 'owner'::app_role)
    OR has_org_role(auth.uid(), organization_id, 'admin'::app_role)
    OR has_org_role(auth.uid(), organization_id, 'super_admin'::app_role)
  )
)
WITH CHECK (
  user_can_access_business(auth.uid(), business_id)
  AND EXISTS (
    SELECT 1 FROM public.consolidation_groups g
    WHERE g.id = consolidation_group_members.group_id
      AND user_can_access_business(auth.uid(), g.parent_business_id)
  )
  AND (
    has_org_role(auth.uid(), organization_id, 'owner'::app_role)
    OR has_org_role(auth.uid(), organization_id, 'admin'::app_role)
    OR has_org_role(auth.uid(), organization_id, 'super_admin'::app_role)
  )
);
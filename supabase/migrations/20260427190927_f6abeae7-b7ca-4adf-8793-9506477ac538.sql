CREATE POLICY "Users can open POS shifts in their branch"
ON public.pos_shifts
FOR INSERT
TO authenticated
WITH CHECK (
  user_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = pos_shifts.organization_id
      AND ur.is_active = true
  )
  AND can_access_branch(auth.uid(), branch_id)
);

CREATE POLICY "Users can update their POS shifts"
ON public.pos_shifts
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = pos_shifts.organization_id
      AND ur.is_active = true
  )
  AND can_access_branch(auth.uid(), branch_id)
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = pos_shifts.organization_id
      AND ur.is_active = true
  )
  AND can_access_branch(auth.uid(), branch_id)
);

CREATE POLICY "Admins can delete POS shifts"
ON public.pos_shifts
FOR DELETE
TO authenticated
USING (
  has_role(auth.uid(), pos_shifts.organization_id, 'owner'::app_role)
  OR has_role(auth.uid(), pos_shifts.organization_id, 'admin'::app_role)
  OR has_role(auth.uid(), pos_shifts.organization_id, 'super_admin'::app_role)
);
DROP POLICY IF EXISTS "Org members can insert POS registers" ON public.pos_registers;
CREATE POLICY "Org members can insert POS registers"
ON public.pos_registers
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = pos_registers.organization_id
      AND ur.is_active = true
  )
  AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
);

DROP POLICY IF EXISTS "Org members can update POS registers" ON public.pos_registers;
CREATE POLICY "Org members can update POS registers"
ON public.pos_registers
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = pos_registers.organization_id
      AND ur.is_active = true
  )
  AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = pos_registers.organization_id
      AND ur.is_active = true
  )
  AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
);

DROP POLICY IF EXISTS "Org admins can delete POS registers" ON public.pos_registers;
CREATE POLICY "Org admins can delete POS registers"
ON public.pos_registers
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = pos_registers.organization_id
      AND ur.is_active = true
      AND ur.role IN ('owner'::app_role, 'admin'::app_role, 'super_admin'::app_role)
  )
);
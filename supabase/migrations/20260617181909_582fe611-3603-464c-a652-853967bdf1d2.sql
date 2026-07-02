-- 1) POS registers: scope admin delete to branches the admin can access
DROP POLICY IF EXISTS "Org admins can delete POS registers" ON public.pos_registers;
CREATE POLICY "Org admins can delete POS registers"
ON public.pos_registers
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = pos_registers.organization_id
      AND ur.is_active = true
      AND ur.role = ANY(ARRAY['owner'::app_role, 'admin'::app_role, 'super_admin'::app_role])
  )
  AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
);

-- 2) POS sessions: branch-scope the v2 update + delete policies
DROP POLICY IF EXISTS pos_sessions_update_v2 ON public.pos_sessions;
CREATE POLICY pos_sessions_update_v2
ON public.pos_sessions
FOR UPDATE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'write')
  AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
)
WITH CHECK (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'write')
  AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
);

DROP POLICY IF EXISTS pos_sessions_delete_v2 ON public.pos_sessions;
CREATE POLICY pos_sessions_delete_v2
ON public.pos_sessions
FOR DELETE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'delete')
  AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
);

-- 3) POS shifts: branch-scope the admin delete
DROP POLICY IF EXISTS "Admins can delete POS shifts" ON public.pos_shifts;
CREATE POLICY "Admins can delete POS shifts"
ON public.pos_shifts
FOR DELETE
USING (
  (
    has_role(auth.uid(), organization_id, 'owner'::app_role)
    OR has_role(auth.uid(), organization_id, 'admin'::app_role)
    OR has_role(auth.uid(), organization_id, 'super_admin'::app_role)
  )
  AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
);

-- 4) Refine the arch view: deny-all and vendor-portal-identity-scoped policies
--    are legitimate carve-outs that should not be flagged as missing a branch arm.
DROP VIEW IF EXISTS public.v_branch_scoped_policy_check;
CREATE VIEW public.v_branch_scoped_policy_check AS
SELECT
  tablename,
  policyname,
  cmd,
  COALESCE(qual, '') || ' ' || COALESCE(with_check, '') AS policy_text,
  (
    -- a) Has an explicit branch predicate
    (COALESCE(qual, '') || ' ' || COALESCE(with_check, ''))
      ~ '(can_access_branch|user_can_access_branch)'
    -- b) Or is a deny-all hardening policy (qual = literal false)
    OR btrim(COALESCE(qual, '')) = 'false'
    OR btrim(COALESCE(with_check, '')) = 'false'
    -- c) Or is scoped to a vendor portal identity (vendors are external,
    --    they don't belong to an employee branch).
    OR (COALESCE(qual, '') || ' ' || COALESCE(with_check, ''))
      ~ 'portal_user_id'
  ) AS has_branch_arm
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'goods_receipts',
    'hardware_command_queue',
    'pos_registers',
    'pos_sessions',
    'pos_shifts',
    'purchase_orders',
    'stock_movements'
  );

GRANT SELECT ON public.v_branch_scoped_policy_check TO authenticated, service_role;
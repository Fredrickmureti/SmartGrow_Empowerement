-- Loop A1: branch-scoped RLS hardening for the two tables still missing branch arms.
-- All other targets (pos_sessions/pos_shifts/pos_registers/stock_movements/purchase_orders)
-- already use can_access_branch / user_can_access_branch — verified 2026-06-17.

-- ============================================================================
-- 1. goods_receipts: add branch arm to all 4 policies, preserving existing
--    user_can_access_business + module-permission checks.
-- ============================================================================
DROP POLICY IF EXISTS "Users view goods receipts in their business" ON public.goods_receipts;
CREATE POLICY "Users view goods receipts in their business"
ON public.goods_receipts FOR SELECT
USING (
  public.user_can_access_business(auth.uid(), business_id)
  AND public.user_can_access_branch(auth.uid(), branch_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'viewer')
);

DROP POLICY IF EXISTS "Users create goods receipts in their business" ON public.goods_receipts;
CREATE POLICY "Users create goods receipts in their business"
ON public.goods_receipts FOR INSERT
WITH CHECK (
  public.user_can_access_business(auth.uid(), business_id)
  AND public.user_can_access_branch(auth.uid(), branch_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'editor')
);

DROP POLICY IF EXISTS "Users update goods receipts in their business" ON public.goods_receipts;
CREATE POLICY "Users update goods receipts in their business"
ON public.goods_receipts FOR UPDATE
USING (
  public.user_can_access_business(auth.uid(), business_id)
  AND public.user_can_access_branch(auth.uid(), branch_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'editor')
);

DROP POLICY IF EXISTS "Users delete goods receipts in their business" ON public.goods_receipts;
CREATE POLICY "Users delete goods receipts in their business"
ON public.goods_receipts FOR DELETE
USING (
  public.user_can_access_business(auth.uid(), business_id)
  AND public.user_can_access_branch(auth.uid(), branch_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'admin')
);

-- ============================================================================
-- 2. hardware_command_queue: SELECT must additionally check branch access.
--    Writes already locked down (hcq_no_client_write / hcq_no_client_update);
--    RPC `claim_next_hardware_command` is SECURITY DEFINER and already branch-aware.
-- ============================================================================
DROP POLICY IF EXISTS hcq_org_read ON public.hardware_command_queue;
CREATE POLICY hcq_org_read ON public.hardware_command_queue
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid()
      AND uba.business_id = hardware_command_queue.org_id
  )
  AND public.user_can_access_branch(auth.uid(), branch_id)
);

-- ============================================================================
-- 3. Arch-test seam: a stable view of branch-aware policies so the new arch
--    test can assert at least these tables carry a branch predicate without
--    re-running pg_policies queries from JS.
-- ============================================================================
CREATE OR REPLACE VIEW public.v_branch_scoped_policy_check AS
SELECT
  tablename,
  policyname,
  COALESCE(qual, '') || ' ' || COALESCE(with_check, '') AS policy_text,
  (COALESCE(qual, '') || ' ' || COALESCE(with_check, ''))
    ~ '(can_access_branch|user_can_access_branch)' AS has_branch_arm
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

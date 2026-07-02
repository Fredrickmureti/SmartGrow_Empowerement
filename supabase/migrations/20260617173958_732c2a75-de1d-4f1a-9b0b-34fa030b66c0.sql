-- Re-create v_branch_scoped_policy_check to expose pg_policies.cmd so the
-- arch test can assert branch arms only on policies where it matters
-- (SELECT/UPDATE/DELETE). INSERT WITH CHECK on these tables is handled
-- by business_id + module-permission predicates already.
DROP VIEW IF EXISTS public.v_branch_scoped_policy_check;
CREATE VIEW public.v_branch_scoped_policy_check AS
SELECT
  tablename,
  policyname,
  cmd,
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
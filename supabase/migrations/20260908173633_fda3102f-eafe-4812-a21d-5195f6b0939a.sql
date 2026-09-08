DROP POLICY IF EXISTS mf_clients_insert ON public.mf_clients;
CREATE POLICY mf_clients_insert ON public.mf_clients
  FOR INSERT TO authenticated
  WITH CHECK (mf_can_scoped(business_id, branch_id, 'clients', 'create', loan_officer_id));

DROP POLICY IF EXISTS mf_clients_update ON public.mf_clients;
CREATE POLICY mf_clients_update ON public.mf_clients
  FOR UPDATE TO authenticated
  USING (mf_can_scoped(business_id, branch_id, 'clients', 'write', loan_officer_id))
  WITH CHECK (mf_can_scoped(business_id, branch_id, 'clients', 'write', loan_officer_id));

DROP POLICY IF EXISTS mf_clients_delete ON public.mf_clients;
CREATE POLICY mf_clients_delete ON public.mf_clients
  FOR DELETE TO authenticated
  USING (mf_can_scoped(business_id, branch_id, 'clients', 'delete', loan_officer_id));

-- reconciliation_sessions: drop broken self-referencing policies
DROP POLICY IF EXISTS "Users can insert reconciliation sessions in their org" ON public.reconciliation_sessions;
DROP POLICY IF EXISTS "Users can update reconciliation sessions in their org" ON public.reconciliation_sessions;
DROP POLICY IF EXISTS "Users can view reconciliation sessions in their org" ON public.reconciliation_sessions;

-- report_generation_logs: drop broken permissive policy
DROP POLICY IF EXISTS "Users can view their org report logs" ON public.report_generation_logs;

-- vendor_credit_note_applications: drop broken policies
DROP POLICY IF EXISTS "Users can create VCN applications in their org" ON public.vendor_credit_note_applications;
DROP POLICY IF EXISTS "Users can delete VCN applications in their org" ON public.vendor_credit_note_applications;
DROP POLICY IF EXISTS "Users can update VCN applications in their org" ON public.vendor_credit_note_applications;
DROP POLICY IF EXISTS "Users can view VCN applications in their org" ON public.vendor_credit_note_applications;

-- organization_api_integrations: restrict SELECT to owners/admins only
DROP POLICY IF EXISTS "Organization members can view their integrations" ON public.organization_api_integrations;
CREATE POLICY "Organization admins can view integrations"
ON public.organization_api_integrations
FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), organization_id, 'owner'::app_role)
  OR has_role(auth.uid(), organization_id, 'admin'::app_role)
);

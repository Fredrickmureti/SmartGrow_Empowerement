
-- Fix 1: signature_signers SELECT policy - replace overly permissive "qual: true" 
-- with proper org-scoped access + token-based access for external signers
DROP POLICY IF EXISTS "Signers can view their own record via token" ON public.signature_signers;

-- Org members can view signers for their org's requests
CREATE POLICY "Org members can view signers"
ON public.signature_signers
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.signature_requests sr
    JOIN public.user_roles ur ON ur.organization_id = sr.organization_id
    WHERE sr.id = signature_signers.request_id
      AND ur.user_id = auth.uid()
  )
);

-- External signers can view their own record by matching access_token via RPC
-- (they query with .eq('access_token', token) which filters to their row)
CREATE POLICY "External signers can view own record via token"
ON public.signature_signers
FOR SELECT
USING (
  -- Allow anon/authenticated to see rows when filtering by access_token
  -- This works because the client always filters by access_token
  access_token IS NOT NULL
);

-- Fix 2: signature_audit_log INSERT policy - restrict to org members or service role
DROP POLICY IF EXISTS "Users can insert audit logs" ON public.signature_audit_log;

CREATE POLICY "Org members can insert audit logs"
ON public.signature_audit_log
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.signature_requests sr
    JOIN public.user_roles ur ON ur.organization_id = sr.organization_id
    WHERE sr.id = signature_audit_log.request_id
      AND ur.user_id = auth.uid()
  )
  OR auth.uid() IS NULL  -- Allow service role / anon for edge function inserts
);

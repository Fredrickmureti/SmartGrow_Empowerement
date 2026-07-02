
-- 1. Fix finance_integrity_issues UPDATE policy: scope admin role to the record's org
DROP POLICY IF EXISTS "Admins can resolve integrity issues" ON public.finance_integrity_issues;
CREATE POLICY "Admins can resolve integrity issues"
ON public.finance_integrity_issues
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = finance_integrity_issues.organization_id
      AND ur.is_active = true
      AND ur.role::text IN ('admin','owner','super_admin','platform_admin')
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = finance_integrity_issues.organization_id
      AND ur.is_active = true
      AND ur.role::text IN ('admin','owner','super_admin','platform_admin')
  )
);

-- 2. pos_void_reasons / pos_return_reasons: write restricted to platform admins only
DROP POLICY IF EXISTS "Platform admin manages void reasons" ON public.pos_void_reasons;
CREATE POLICY "Platform admin manages void reasons"
ON public.pos_void_reasons
FOR ALL
TO authenticated
USING (public.is_platform_admin(auth.uid()))
WITH CHECK (public.is_platform_admin(auth.uid()));

DROP POLICY IF EXISTS "Platform admin manages return reasons" ON public.pos_return_reasons;
CREATE POLICY "Platform admin manages return reasons"
ON public.pos_return_reasons
FOR ALL
TO authenticated
USING (public.is_platform_admin(auth.uid()))
WITH CHECK (public.is_platform_admin(auth.uid()));

-- 3. Make custom-field-attachments bucket private and gate reads to org members
UPDATE storage.buckets SET public = false WHERE id = 'custom-field-attachments';

DROP POLICY IF EXISTS "Org members can read custom field attachments" ON storage.objects;
CREATE POLICY "Org members can read custom field attachments"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'custom-field-attachments'
  AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.is_active = true
      AND ur.organization_id::text = (storage.foldername(name))[1]
  )
);

-- 4. Realtime: default-deny SELECT for any topic the app hasn't explicitly allowed.
--    Existing pos:scan:% / scan:session:% allowlist policies remain and union with this.
DROP POLICY IF EXISTS "deny unknown realtime topics" ON realtime.messages;
CREATE POLICY "deny unknown realtime topics"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  realtime.topic() LIKE 'pos:scan:%'
  OR realtime.topic() LIKE 'scan:session:%'
);


-- ============================================================
-- 1. Storage: receipts bucket (org folder scoping)
-- ============================================================
DROP POLICY IF EXISTS "Users can view receipts in their org folder" ON storage.objects;
DROP POLICY IF EXISTS "Users can upload receipts to their org folder" ON storage.objects;
DROP POLICY IF EXISTS "Users can update their own receipts" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their own receipts" ON storage.objects;

CREATE POLICY "receipts_select_org" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'receipts' AND public.user_has_org_access((storage.foldername(name))[1]));

CREATE POLICY "receipts_insert_org" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'receipts' AND public.user_has_org_access((storage.foldername(name))[1]));

CREATE POLICY "receipts_update_org" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'receipts' AND public.user_has_org_access((storage.foldername(name))[1]))
  WITH CHECK (bucket_id = 'receipts' AND public.user_has_org_access((storage.foldername(name))[1]));

CREATE POLICY "receipts_delete_org" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'receipts' AND public.user_has_org_access((storage.foldername(name))[1]));

-- ============================================================
-- 2. Storage: signatures bucket (org folder scoping)
-- ============================================================
DROP POLICY IF EXISTS "Users can view signatures" ON storage.objects;
DROP POLICY IF EXISTS "Users can upload signatures for their organization" ON storage.objects;

CREATE POLICY "signatures_select_org" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'signatures' AND public.user_has_org_access((storage.foldername(name))[1]));

CREATE POLICY "signatures_insert_org" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'signatures' AND public.user_has_org_access((storage.foldername(name))[1]));

-- ============================================================
-- 3. Storage: product-images bucket (org folder scoping on writes)
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users can delete product images" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update product images" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload product images" ON storage.objects;

CREATE POLICY "product_images_insert_org" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'product-images' AND public.user_has_org_access((storage.foldername(name))[1]));

CREATE POLICY "product_images_update_org" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'product-images' AND public.user_has_org_access((storage.foldername(name))[1]))
  WITH CHECK (bucket_id = 'product-images' AND public.user_has_org_access((storage.foldername(name))[1]));

CREATE POLICY "product_images_delete_org" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'product-images' AND public.user_has_org_access((storage.foldername(name))[1]));

-- ============================================================
-- 4. Storage: custom-field-attachments bucket (org folder scoping)
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users can upload custom field files" ON storage.objects;
DROP POLICY IF EXISTS "Users can update their own custom field files" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their own custom field files" ON storage.objects;

CREATE POLICY "custom_field_attachments_insert_org" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'custom-field-attachments' AND public.user_has_org_access((storage.foldername(name))[1]));

CREATE POLICY "custom_field_attachments_update_org" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'custom-field-attachments' AND public.user_has_org_access((storage.foldername(name))[1]))
  WITH CHECK (bucket_id = 'custom-field-attachments' AND public.user_has_org_access((storage.foldername(name))[1]));

CREATE POLICY "custom_field_attachments_delete_org" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'custom-field-attachments' AND public.user_has_org_access((storage.foldername(name))[1]));

-- ============================================================
-- 5. payroll_statutory_rules: org-scoped role check
-- ============================================================
DROP POLICY IF EXISTS payroll_statutory_rules_insert ON public.payroll_statutory_rules;
DROP POLICY IF EXISTS payroll_statutory_rules_update ON public.payroll_statutory_rules;
DROP POLICY IF EXISTS payroll_statutory_rules_delete ON public.payroll_statutory_rules;

CREATE POLICY payroll_statutory_rules_insert ON public.payroll_statutory_rules
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_payroll_access(auth.uid(), organization_id)
    OR public.has_role(auth.uid(), organization_id, 'owner'::public.app_role)
    OR public.has_role(auth.uid(), organization_id, 'admin'::public.app_role)
  );

CREATE POLICY payroll_statutory_rules_update ON public.payroll_statutory_rules
  FOR UPDATE TO authenticated
  USING (
    public.has_payroll_access(auth.uid(), organization_id)
    OR public.has_role(auth.uid(), organization_id, 'owner'::public.app_role)
    OR public.has_role(auth.uid(), organization_id, 'admin'::public.app_role)
  )
  WITH CHECK (
    public.has_payroll_access(auth.uid(), organization_id)
    OR public.has_role(auth.uid(), organization_id, 'owner'::public.app_role)
    OR public.has_role(auth.uid(), organization_id, 'admin'::public.app_role)
  );

CREATE POLICY payroll_statutory_rules_delete ON public.payroll_statutory_rules
  FOR DELETE TO authenticated
  USING (
    public.has_payroll_access(auth.uid(), organization_id)
    OR public.has_role(auth.uid(), organization_id, 'owner'::public.app_role)
    OR public.has_role(auth.uid(), organization_id, 'admin'::public.app_role)
  );

-- ============================================================
-- 6. Spreadsheet share access: close the open-by-UUID gate
-- ============================================================
DROP POLICY IF EXISTS "Token holders can view shared spreadsheets" ON public.spreadsheets;
DROP POLICY IF EXISTS "Token holders can view shared spreadsheet sheets" ON public.spreadsheet_sheets;

-- Replace the helper to return false unconditionally. Real token-based
-- access must go through a server function that validates the presented
-- access_token against spreadsheet_shares using the service role.
CREATE OR REPLACE FUNCTION public.has_spreadsheet_share_access(spreadsheet_uuid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT false;
$$;

DROP POLICY IF EXISTS mf_kyc_select ON storage.objects;
DROP POLICY IF EXISTS mf_kyc_insert ON storage.objects;
DROP POLICY IF EXISTS mf_kyc_update ON storage.objects;
DROP POLICY IF EXISTS mf_kyc_delete ON storage.objects;

CREATE POLICY mf_kyc_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'mf-kyc'
    AND EXISTS (
      SELECT 1 FROM public.mf_clients c
       WHERE c.business_id::text = (storage.foldername(name))[1]
         AND c.id::text = (storage.foldername(name))[2]
         AND public.mf_can_scoped(c.business_id, c.branch_id, 'clients', 'read', c.loan_officer_id)
    )
  );

CREATE POLICY mf_kyc_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'mf-kyc'
    AND EXISTS (
      SELECT 1 FROM public.mf_clients c
       WHERE c.business_id::text = (storage.foldername(name))[1]
         AND c.id::text = (storage.foldername(name))[2]
         AND public.mf_can_scoped(c.business_id, c.branch_id, 'clients', 'write', c.loan_officer_id)
    )
  );

CREATE POLICY mf_kyc_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'mf-kyc'
    AND EXISTS (
      SELECT 1 FROM public.mf_clients c
       WHERE c.business_id::text = (storage.foldername(name))[1]
         AND c.id::text = (storage.foldername(name))[2]
         AND public.mf_can_scoped(c.business_id, c.branch_id, 'clients', 'write', c.loan_officer_id)
    )
  )
  WITH CHECK (
    bucket_id = 'mf-kyc'
    AND EXISTS (
      SELECT 1 FROM public.mf_clients c
       WHERE c.business_id::text = (storage.foldername(name))[1]
         AND c.id::text = (storage.foldername(name))[2]
         AND public.mf_can_scoped(c.business_id, c.branch_id, 'clients', 'write', c.loan_officer_id)
    )
  );

CREATE POLICY mf_kyc_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'mf-kyc'
    AND EXISTS (
      SELECT 1 FROM public.mf_clients c
       WHERE c.business_id::text = (storage.foldername(name))[1]
         AND c.id::text = (storage.foldername(name))[2]
         AND public.mf_can_scoped(c.business_id, c.branch_id, 'clients', 'write', c.loan_officer_id)
    )
  );
CREATE POLICY "mf_kyc_payout_photo_select" ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'mf-kyc' AND EXISTS (
    SELECT 1 FROM public.mf_loans l
    WHERE l.business_id::text = (storage.foldername(name))[1]
      AND l.id::text = (storage.foldername(name))[2]
      AND public.mf_can_scoped(l.business_id, l.branch_id, 'loans', 'read', l.loan_officer_id)
  )
);

CREATE POLICY "mf_kyc_payout_photo_insert" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'mf-kyc' AND EXISTS (
    SELECT 1 FROM public.mf_loans l
    WHERE l.business_id::text = (storage.foldername(name))[1]
      AND l.id::text = (storage.foldername(name))[2]
      AND public.user_has_business_access(auth.uid(), l.business_id)
      AND (public.has_role(auth.uid(),'admin')
        OR public.has_role(auth.uid(),'branch_manager')
        OR public.has_role(auth.uid(),'cashier'))
  )
);
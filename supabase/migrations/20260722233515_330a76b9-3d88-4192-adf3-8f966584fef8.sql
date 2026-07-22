
-- RLS on storage.objects for the legal-orders bucket
CREATE POLICY legal_orders_bucket_read
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'legal-orders'
    AND (
      public.has_role(auth.uid(), 'admin')
      OR public.has_role(auth.uid(), 'owner')
      OR public.has_role(auth.uid(), 'accountant')
      OR public.has_role(auth.uid(), 'super_admin')
      OR public.has_role(auth.uid(), 'manager')
    )
  );

CREATE POLICY legal_orders_bucket_insert
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'legal-orders'
    AND (
      public.has_role(auth.uid(), 'admin')
      OR public.has_role(auth.uid(), 'owner')
      OR public.has_role(auth.uid(), 'accountant')
      OR public.has_role(auth.uid(), 'super_admin')
    )
  );

CREATE POLICY legal_orders_bucket_update
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'legal-orders'
    AND (
      public.has_role(auth.uid(), 'admin')
      OR public.has_role(auth.uid(), 'owner')
      OR public.has_role(auth.uid(), 'super_admin')
    )
  );

CREATE POLICY legal_orders_bucket_delete
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'legal-orders'
    AND (
      public.has_role(auth.uid(), 'admin')
      OR public.has_role(auth.uid(), 'owner')
      OR public.has_role(auth.uid(), 'super_admin')
    )
  );

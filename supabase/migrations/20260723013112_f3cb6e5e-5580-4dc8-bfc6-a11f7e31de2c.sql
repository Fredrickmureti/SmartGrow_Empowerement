
-- Employee self-service: read own legal_order_documents
CREATE POLICY "legal_order_documents_employee_self_read"
ON public.legal_order_documents
FOR SELECT
TO authenticated
USING (
  garnishment_id IN (
    SELECT lor.id FROM public.legal_orders_records lor
    JOIN public.employees e ON e.id = lor.employee_id
    WHERE e.user_id = auth.uid()
  )
);

-- Employee self-service: insert evidence for own legal orders
CREATE POLICY "legal_order_documents_employee_self_write"
ON public.legal_order_documents
FOR INSERT
TO authenticated
WITH CHECK (
  uploaded_by = auth.uid()
  AND garnishment_id IN (
    SELECT lor.id FROM public.legal_orders_records lor
    JOIN public.employees e ON e.id = lor.employee_id
    WHERE e.user_id = auth.uid()
  )
);

-- Storage: allow employees to read/insert files in the legal-orders bucket
-- limited to paths under their own order id: {org}/{garnishment_id}/{version}-{kind}-{filename}
CREATE POLICY "legal_orders_bucket_employee_self_read"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'legal-orders'
  AND (
    (storage.foldername(name))[2] IN (
      SELECT lor.id::text FROM public.legal_orders_records lor
      JOIN public.employees e ON e.id = lor.employee_id
      WHERE e.user_id = auth.uid()
    )
  )
);

CREATE POLICY "legal_orders_bucket_employee_self_insert"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'legal-orders'
  AND owner = auth.uid()
  AND (
    (storage.foldername(name))[2] IN (
      SELECT lor.id::text FROM public.legal_orders_records lor
      JOIN public.employees e ON e.id = lor.employee_id
      WHERE e.user_id = auth.uid()
    )
  )
);

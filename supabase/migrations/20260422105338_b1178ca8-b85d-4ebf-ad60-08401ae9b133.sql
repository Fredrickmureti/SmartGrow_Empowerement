-- Tighten SELECT (listing) on public buckets. Public file URLs still work
-- because public buckets bypass RLS for direct file fetches; only the
-- bucket-listing API is governed by these policies.

DROP POLICY IF EXISTS "Anyone can view product images" ON storage.objects;
CREATE POLICY "Authenticated users can list product images"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'product-images');

DROP POLICY IF EXISTS "Anyone can view user avatars" ON storage.objects;
CREATE POLICY "Authenticated users can list user avatars"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'user-avatars');

DROP POLICY IF EXISTS "Anyone can view custom field files" ON storage.objects;
CREATE POLICY "Authenticated users can list custom field files"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'custom-field-attachments');

-- employee-avatars already requires authentication for SELECT — no change.

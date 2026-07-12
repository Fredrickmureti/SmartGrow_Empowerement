-- Restrict the `localization-assets` staging bucket to platform admins.
-- This bucket is a short-lived hand-off zone: admins upload master
-- workbooks here, then invoke `hydrate-localization-binary-asset` which
-- copies the bytes into `localization_pack_binary_assets.bytes` (canonical)
-- and deletes the staged object. No tenant user should ever see it.

CREATE POLICY "platform admins manage localization-assets bucket"
ON storage.objects
FOR ALL
TO authenticated
USING (
  bucket_id = 'localization-assets'
  AND public.is_platform_admin(auth.uid())
)
WITH CHECK (
  bucket_id = 'localization-assets'
  AND public.is_platform_admin(auth.uid())
);
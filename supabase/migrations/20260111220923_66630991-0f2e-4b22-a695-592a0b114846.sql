-- Create storage bucket for organization assets (logos, etc.)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'organization-assets',
  'organization-assets',
  true,
  2097152, -- 2MB limit
  ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml']
) ON CONFLICT (id) DO NOTHING;

-- Create policy for viewing organization logos (public)
CREATE POLICY "Organization logos are publicly accessible"
ON storage.objects FOR SELECT
USING (bucket_id = 'organization-assets');

-- Create policy for organization members to upload logos
CREATE POLICY "Organization members can upload logos"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'organization-assets' 
  AND (storage.foldername(name))[1] IN (
    SELECT id::text FROM organizations 
    WHERE id IN (SELECT get_user_organizations(auth.uid()))
  )
);

-- Create policy for organization members to update logos
CREATE POLICY "Organization members can update logos"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'organization-assets' 
  AND (storage.foldername(name))[1] IN (
    SELECT id::text FROM organizations 
    WHERE id IN (SELECT get_user_organizations(auth.uid()))
  )
);

-- Create policy for organization members to delete logos
CREATE POLICY "Organization members can delete logos"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'organization-assets' 
  AND (storage.foldername(name))[1] IN (
    SELECT id::text FROM organizations 
    WHERE id IN (SELECT get_user_organizations(auth.uid()))
  )
);

-- Add additional organization fields for branding if not present
DO $$
BEGIN
  -- Add address fields if they don't exist
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'address') THEN
    ALTER TABLE organizations ADD COLUMN address text;
  END IF;
END $$;
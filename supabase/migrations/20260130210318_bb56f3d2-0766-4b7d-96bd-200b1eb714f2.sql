-- Create documents storage bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'documents',
  'documents',
  false,
  52428800,
  ARRAY[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'text/csv'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- Create sign-documents storage bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'sign-documents',
  'sign-documents',
  false,
  52428800,
  ARRAY[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- Create security definer function to check org membership
CREATE OR REPLACE FUNCTION public.user_has_org_access(org_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
      AND organization_id::text = org_id
      AND is_active = true
  )
$$;

-- RLS policies for documents bucket
CREATE POLICY "documents_insert_policy"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'documents' AND
  public.user_has_org_access((storage.foldername(name))[1])
);

CREATE POLICY "documents_select_policy"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'documents' AND
  public.user_has_org_access((storage.foldername(name))[1])
);

CREATE POLICY "documents_update_policy"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'documents' AND
  public.user_has_org_access((storage.foldername(name))[1])
);

CREATE POLICY "documents_delete_policy"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'documents' AND
  public.user_has_org_access((storage.foldername(name))[1])
);

-- RLS policies for sign-documents bucket
CREATE POLICY "sign_documents_insert_policy"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'sign-documents' AND
  public.user_has_org_access((storage.foldername(name))[1])
);

CREATE POLICY "sign_documents_select_policy"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'sign-documents' AND
  public.user_has_org_access((storage.foldername(name))[1])
);

CREATE POLICY "sign_documents_update_policy"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'sign-documents' AND
  public.user_has_org_access((storage.foldername(name))[1])
);

CREATE POLICY "sign_documents_delete_policy"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'sign-documents' AND
  public.user_has_org_access((storage.foldername(name))[1])
);
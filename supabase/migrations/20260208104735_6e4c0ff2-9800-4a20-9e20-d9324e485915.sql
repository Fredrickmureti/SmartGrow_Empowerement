-- Create document-pdfs storage bucket for auto-generated PDFs
INSERT INTO storage.buckets (id, name, public)
VALUES ('document-pdfs', 'document-pdfs', false)
ON CONFLICT (id) DO NOTHING;

-- RLS Policy: Organization members can view their document PDFs
CREATE POLICY "Organization members can view document PDFs"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'document-pdfs' AND
  (storage.foldername(name))[1] IN (
    SELECT id::text FROM public.organizations 
    WHERE id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  )
);

-- RLS Policy: Organization members can upload document PDFs
CREATE POLICY "Organization members can upload document PDFs"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'document-pdfs' AND
  (storage.foldername(name))[1] IN (
    SELECT id::text FROM public.organizations 
    WHERE id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  )
);

-- RLS Policy: Organization members can delete their document PDFs
CREATE POLICY "Organization members can delete document PDFs"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'document-pdfs' AND
  (storage.foldername(name))[1] IN (
    SELECT id::text FROM public.organizations 
    WHERE id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid())
  )
);

-- Add PDF tracking columns to document_emails table
ALTER TABLE public.document_emails 
ADD COLUMN IF NOT EXISTS pdf_storage_path TEXT,
ADD COLUMN IF NOT EXISTS pdf_generated_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS pdf_file_size_bytes INTEGER;
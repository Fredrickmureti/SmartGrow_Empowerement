
-- Create storage bucket for custom field file uploads
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('custom-field-attachments', 'custom-field-attachments', true, 10485760)
ON CONFLICT (id) DO NOTHING;

-- RLS policies for the bucket
CREATE POLICY "Authenticated users can upload custom field files"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'custom-field-attachments');

CREATE POLICY "Anyone can view custom field files"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'custom-field-attachments');

CREATE POLICY "Users can update their own custom field files"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'custom-field-attachments');

CREATE POLICY "Users can delete their own custom field files"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'custom-field-attachments');

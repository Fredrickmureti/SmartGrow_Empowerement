
-- Phase 2: Add avatar_url to employees table
ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS avatar_url text;

-- Create employee-avatars storage bucket (public for easy image serving)
INSERT INTO storage.buckets (id, name, public)
VALUES ('employee-avatars', 'employee-avatars', true)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS policies for employee-avatars bucket

-- Anyone authenticated can view avatars (public bucket, but let's be explicit)
CREATE POLICY "Anyone can view employee avatars"
ON storage.objects FOR SELECT
USING (bucket_id = 'employee-avatars');

-- Employees can upload their own avatar (path: {org_id}/{employee_id}/*)
CREATE POLICY "Employees can upload own avatar"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'employee-avatars'
);

-- Employees can update their own avatar
CREATE POLICY "Employees can update own avatar"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'employee-avatars');

-- Employees can delete their own avatar
CREATE POLICY "Employees can delete own avatar"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'employee-avatars');

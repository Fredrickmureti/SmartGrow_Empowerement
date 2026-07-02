-- Add email display settings to organizations table
ALTER TABLE public.organizations 
  ADD COLUMN IF NOT EXISTS email_display_name TEXT,
  ADD COLUMN IF NOT EXISTS email_reply_to TEXT;

-- Add comment for documentation
COMMENT ON COLUMN public.organizations.email_display_name IS 'Custom display name for outgoing emails (e.g., "Design Sphere")';
COMMENT ON COLUMN public.organizations.email_reply_to IS 'Reply-to email address for outgoing emails';
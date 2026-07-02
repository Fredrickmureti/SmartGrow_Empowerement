-- Phase 1: Insert missing resend_reply_to_email setting
INSERT INTO platform_settings (
  setting_key,
  setting_value,
  setting_type,
  description,
  is_secret
) VALUES (
  'resend_reply_to_email',
  NULL,
  'string',
  'Reply-To email address for platform emails sent via Resend',
  false
) ON CONFLICT (setting_key) DO NOTHING;

-- Phase 3: Add reply_to column to platform_email_logs for audit trail
ALTER TABLE platform_email_logs 
ADD COLUMN IF NOT EXISTS reply_to text;

-- Phase 1: Fix critical credential exposure vulnerability
-- Create a secure view that excludes the credentials column for non-admin users
CREATE OR REPLACE VIEW public.public_payment_providers AS
SELECT
  id,
  provider,
  display_name,
  description,
  logo_url,
  is_enabled,
  is_test_mode,
  webhook_url,
  callback_url,
  supported_currencies,
  last_tested_at,
  test_status,
  test_error,
  created_at,
  updated_at
FROM public.platform_payment_providers
WHERE is_enabled = true;

-- Drop the dangerous public SELECT policy that exposes credentials to all users
DROP POLICY IF EXISTS "Public can view enabled providers" ON public.platform_payment_providers;

-- Create a new restricted policy: only platform admins can SELECT the full table (including credentials)
CREATE POLICY "Only platform admins can read provider configs"
ON public.platform_payment_providers
FOR SELECT
USING (is_platform_admin(auth.uid()));

-- Phase 2: Add index on webhook_events for efficient cleanup
CREATE INDEX IF NOT EXISTS idx_webhook_events_processed_at ON public.webhook_events (processed_at);

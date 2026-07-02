
-- Fix security definer view warning: use SECURITY INVOKER explicitly
CREATE OR REPLACE VIEW public.public_payment_providers
WITH (security_invoker = true) AS
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

-- Grant SELECT on the view to authenticated users (since RLS on the base table now blocks them)
GRANT SELECT ON public.public_payment_providers TO authenticated;
GRANT SELECT ON public.public_payment_providers TO anon;

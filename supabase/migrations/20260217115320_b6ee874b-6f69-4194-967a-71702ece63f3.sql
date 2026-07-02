
-- Fix: Change the masked view to SECURITY INVOKER (default, explicit)
DROP VIEW IF EXISTS public.sms_provider_configs_masked;

CREATE VIEW public.sms_provider_configs_masked
WITH (security_invoker = true)
AS
SELECT
  id,
  organization_id,
  business_id,
  provider,
  is_enabled,
  CASE WHEN length(account_sid) > 4 THEN '****' || right(account_sid, 4) ELSE '****' END AS account_sid_masked,
  '********' AS auth_token_masked,
  sender_phone,
  messaging_service_sid,
  webhook_url,
  created_by,
  created_at,
  updated_at
FROM public.sms_provider_configs;

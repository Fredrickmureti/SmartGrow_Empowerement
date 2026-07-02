-- Create a public view for bank providers that hides sensitive credentials
-- Regular users will query this view instead of the base table

CREATE VIEW public.bank_providers_public
WITH (security_invoker = on) AS
SELECT 
  id,
  provider_code,
  provider_name,
  description,
  logo_url,
  is_enabled,
  is_sandbox,
  supported_countries,
  created_at,
  updated_at
  -- Excludes: api_key_encrypted, api_secret_encrypted, merchant_code, 
  -- public_key, private_key_encrypted, api_base_url, config
FROM public.platform_bank_providers
WHERE is_enabled = true;
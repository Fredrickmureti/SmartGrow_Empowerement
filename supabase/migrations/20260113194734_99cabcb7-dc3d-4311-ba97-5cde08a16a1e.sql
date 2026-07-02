-- Add additional Kenyan bank providers to platform_bank_providers
INSERT INTO platform_bank_providers (provider_code, provider_name, description, api_base_url, supported_countries, is_enabled, is_sandbox, config)
VALUES
-- NCBA Open Banking API
('ncba', 'NCBA Bank', 'NCBA Open Banking API for payments, account services, and fund transfers. Supports Kenya, Uganda, and Tanzania.', 'https://developers.cbagroup.com', ARRAY['KE', 'UG', 'TZ'], false, true, '{"auth_type": "api_key", "requires_api_user": true, "requires_api_key": true}'::jsonb),

-- Absa Africa (formerly Barclays)
('absa', 'Absa Bank Kenya', 'Absa Access API with Open Banking standards, OAuth 2.0 authentication, and mTLS support for production.', 'https://api.absa.africa', ARRAY['KE'], false, true, '{"auth_type": "oauth2", "requires_client_id": true, "requires_client_secret": true, "requires_certificate": true}'::jsonb),

-- Standard Chartered Open Banking
('stanchart', 'Standard Chartered', 'Standard Chartered Open Banking APIs for cash management, FX, and account services with JWT authentication.', 'https://openbanking.sc.com', ARRAY['KE'], false, true, '{"auth_type": "oauth2_jwt", "requires_api_key": true, "requires_api_secret": true, "requires_jwt_key": true}'::jsonb),

-- I&M Bank Payment Gateway
('im_bank', 'I&M Bank', 'I&M Payment API Gateway for host-to-host integration with 2FA security token authentication.', 'https://api.imbankgroup.com', ARRAY['KE'], false, true, '{"auth_type": "basic_2fa", "requires_username": true, "requires_password": true, "requires_security_token": true}'::jsonb),

-- Stanbic Bank Kenya
('stanbic', 'Stanbic Bank', 'Stanbic Bank Kenya API for account services, payments, and statements with OAuth 2.0 authentication.', 'https://api.stanbicbank.co.ke', ARRAY['KE'], false, true, '{"auth_type": "oauth2", "requires_consumer_key": true, "requires_consumer_secret": true}'::jsonb),

-- DTB via Astra Africa
('dtb_astra', 'Diamond Trust Bank (Astra)', 'DTB integration via Astra Africa API gateway for account services and payments across East Africa.', 'https://api.astraafrica.co', ARRAY['KE', 'UG', 'TZ'], false, true, '{"auth_type": "api_key", "requires_api_key": true, "requires_api_secret": true, "requires_merchant_id": true}'::jsonb)
ON CONFLICT (provider_code) DO UPDATE SET
  provider_name = EXCLUDED.provider_name,
  description = EXCLUDED.description,
  api_base_url = EXCLUDED.api_base_url,
  supported_countries = EXCLUDED.supported_countries,
  config = EXCLUDED.config,
  updated_at = now();
-- Add M-Pesa environment platform setting
INSERT INTO public.platform_settings (setting_key, setting_value, setting_type, description, is_secret)
VALUES (
  'mpesa_environment',
  'sandbox',
  'string',
  'M-Pesa API environment: sandbox (for testing) or production (for live transactions). Controlled by platform admin only.',
  false
)
ON CONFLICT (setting_key) DO NOTHING;
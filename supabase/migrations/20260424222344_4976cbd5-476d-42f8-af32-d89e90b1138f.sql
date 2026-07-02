-- Idempotent insert: do not overwrite if a value already exists.
INSERT INTO public.platform_settings (setting_key, setting_value, setting_type, description, is_secret)
VALUES (
  'allow_admin_pin_login',
  'true',
  'boolean',
  'When true, platform admins can set up and use a quick PIN login (mirrors the tenant Security setting). Set to false to enforce password-only authentication for all platform admins.',
  false
)
ON CONFLICT (setting_key) DO NOTHING;
INSERT INTO public.platform_settings (setting_key, setting_value, setting_type, description, is_secret, updated_at)
VALUES
  ('platform_name', 'Smart Grow Empowerment', 'string', 'The name of the platform displayed to users', false, now()),
  ('website_url', 'https://www.growastepventures.co.ke/', 'string', 'Public website URL', false, now()),
  ('app_base_url', 'https://www.growastepventures.co.ke/', 'string', 'Canonical application URL used for invitation and notification links', false, now())
ON CONFLICT (setting_key) DO UPDATE
SET setting_value = EXCLUDED.setting_value,
    updated_at = now();
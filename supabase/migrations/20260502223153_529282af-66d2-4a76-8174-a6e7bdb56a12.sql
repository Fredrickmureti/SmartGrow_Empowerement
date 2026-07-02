-- Scoped email identity settings — replace single global Reply-To with category-aware fields
INSERT INTO public.platform_settings (setting_key, setting_value, description)
VALUES
  ('support_reply_to_email', NULL, 'Reply-To used for invitations and general support emails. Leave blank to omit.'),
  ('platform_admin_reply_to_email', NULL, 'Reply-To used only for platform-admin composed messages. Do NOT use for system notifications.'),
  ('app_base_url', NULL, 'Absolute base URL of the app, used to build clickable deep links in notification emails (e.g. https://app.example.com).')
ON CONFLICT (setting_key) DO NOTHING;
-- Insert Sentry configuration settings into platform_settings
INSERT INTO platform_settings (setting_key, setting_type, setting_value, description, is_secret)
VALUES 
  ('sentry_enabled', 'boolean', 'false', 'Enable Sentry error tracking', false),
  ('sentry_dsn', 'string', NULL, 'Sentry DSN for error tracking (public key)', false),
  ('sentry_environment', 'string', 'auto', 'Sentry environment (auto, production, preview)', false),
  ('sentry_sample_rate', 'string', '0.1', 'Error sampling rate (0.0 to 1.0)', false)
ON CONFLICT (setting_key) DO NOTHING;
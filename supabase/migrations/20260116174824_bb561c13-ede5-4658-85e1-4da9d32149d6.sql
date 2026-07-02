-- Add eTIMS platform-level settings
INSERT INTO platform_settings (setting_key, setting_value, setting_type, description, is_secret)
VALUES 
  ('etims_enabled', 'true', 'boolean', 'Global toggle to enable/disable eTIMS integration for all organizations', false),
  ('etims_environment', 'sandbox', 'string', 'eTIMS environment mode: sandbox or production', false),
  ('etims_api_sandbox_url', 'https://etims-api-sbx.kra.go.ke/etims-api', 'string', 'KRA eTIMS Sandbox API Base URL', false),
  ('etims_api_production_url', 'https://etims-api.kra.go.ke/etims-api', 'string', 'KRA eTIMS Production API Base URL', false),
  ('etims_last_global_code_sync', NULL, 'timestamp', 'Last time standard codes were synchronized globally', false)
ON CONFLICT (setting_key) DO NOTHING;
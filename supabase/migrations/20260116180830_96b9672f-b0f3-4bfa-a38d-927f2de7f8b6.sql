-- Add vendor credential settings to platform_settings for eTIMS integration
-- These are platform-level credentials the vendor receives from KRA after certification

INSERT INTO platform_settings (setting_key, setting_value, setting_type, description, is_secret)
VALUES 
  ('etims_vendor_tin', '', 'string', 'Platform vendor KRA PIN (TIN) for eTIMS certification', false),
  ('etims_vendor_branch_id', '00', 'string', 'Platform vendor branch ID', false),
  ('etims_vendor_device_serial', '', 'string', 'Platform vendor device serial number (assigned after initialization)', false),
  ('etims_vendor_initialized', 'false', 'boolean', 'Whether the vendor device has been initialized with KRA', false),
  ('etims_vendor_last_test', '', 'string', 'Timestamp of last successful API connection test', false)
ON CONFLICT (setting_key) DO NOTHING;

-- Phase 1: Activate pos_hardware_configs with new columns for device registry
ALTER TABLE pos_hardware_configs 
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS driver_type text,
  ADD COLUMN IF NOT EXISTS device_role text,
  ADD COLUMN IF NOT EXISTS device_identifier text,
  ADD COLUMN IF NOT EXISTS firmware_version text,
  ADD COLUMN IF NOT EXISTS capabilities jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS last_error text;

-- Add constraint for valid device roles
ALTER TABLE pos_hardware_configs 
  ADD CONSTRAINT valid_device_role CHECK (
    device_role IS NULL OR device_role IN (
      'receipt_printer', 'cash_drawer', 'barcode_scanner', 
      'customer_display', 'scale', 'payment_terminal', 'label_printer'
    )
  );

-- Add constraint for valid status
ALTER TABLE pos_hardware_configs 
  ADD CONSTRAINT valid_device_status CHECK (
    status IN ('online', 'offline', 'unknown', 'error', 'configuring')
  );

-- Add constraint for valid driver types  
ALTER TABLE pos_hardware_configs 
  ADD CONSTRAINT valid_driver_type CHECK (
    driver_type IS NULL OR driver_type IN (
      'escpos', 'star', 'citizen', 'bixolon', 'epson',
      'generic_scale', 'toledo_scale', 'cas_scale', 'mettler_scale',
      'keyboard_scanner', 'hid_scanner',
      'escpos_drawer',
      'secondary_screen_display', 'line_display',
      'worldline_terminal', 'adyen_terminal', 'generic_terminal',
      'browser_print'
    )
  );

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_pos_hardware_configs_register_role 
  ON pos_hardware_configs(register_id, device_role) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_pos_hardware_configs_org_active 
  ON pos_hardware_configs(organization_id) WHERE is_active = true;

-- RLS policies
ALTER TABLE pos_hardware_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view hardware configs for their org"
  ON pos_hardware_configs FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM profiles WHERE id = auth.uid()
  ));

CREATE POLICY "Users can manage hardware configs for their org"
  ON pos_hardware_configs FOR ALL TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM profiles WHERE id = auth.uid()
  ))
  WITH CHECK (organization_id IN (
    SELECT organization_id FROM profiles WHERE id = auth.uid()
  ));

-- Create hardware configuration table
CREATE TABLE IF NOT EXISTS pos_hardware_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  register_id UUID REFERENCES pos_registers(id) ON DELETE CASCADE,
  hardware_type TEXT NOT NULL CHECK (hardware_type IN ('printer', 'cash_drawer', 'scale', 'customer_display', 'barcode_scanner')),
  display_name TEXT NOT NULL,
  connection_type TEXT NOT NULL CHECK (connection_type IN ('usb', 'network', 'serial', 'bluetooth', 'browser')),
  connection_params JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE pos_hardware_configs ENABLE ROW LEVEL SECURITY;

-- RLS Policies for hardware configs
CREATE POLICY "Users can view hardware configs for their organization"
  ON pos_hardware_configs FOR SELECT
  USING (organization_id IN (
    SELECT organization_id FROM user_roles WHERE user_id = auth.uid()
  ));

CREATE POLICY "Users can insert hardware configs for their organization"
  ON pos_hardware_configs FOR INSERT
  WITH CHECK (organization_id IN (
    SELECT organization_id FROM user_roles WHERE user_id = auth.uid()
  ));

CREATE POLICY "Users can update hardware configs for their organization"
  ON pos_hardware_configs FOR UPDATE
  USING (organization_id IN (
    SELECT organization_id FROM user_roles WHERE user_id = auth.uid()
  ));

CREATE POLICY "Users can delete hardware configs for their organization"
  ON pos_hardware_configs FOR DELETE
  USING (organization_id IN (
    SELECT organization_id FROM user_roles WHERE user_id = auth.uid()
  ));

-- Trigger for updated_at
CREATE OR REPLACE TRIGGER update_pos_hardware_configs_updated_at
  BEFORE UPDATE ON pos_hardware_configs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
-- Phase 1: Rename NHIF to SHIF (Social Health Insurance Fund)
-- Add new shif_number column and migrate data from nhif_number
ALTER TABLE employees ADD COLUMN IF NOT EXISTS shif_number TEXT;

-- Copy existing nhif_number data to shif_number
UPDATE employees SET shif_number = nhif_number WHERE nhif_number IS NOT NULL AND shif_number IS NULL;

-- Add comment explaining the change
COMMENT ON COLUMN employees.shif_number IS 'Social Health Insurance Fund (SHIF) number - replaced NHIF in 2024';
COMMENT ON COLUMN employees.nhif_number IS 'DEPRECATED: Use shif_number instead. NHIF was replaced by SHIF in 2024';

-- Phase 2: Create employee field configuration tables for customizable fields

-- Table to store field configurations per organization
CREATE TABLE IF NOT EXISTS employee_field_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  field_label TEXT NOT NULL,
  field_type TEXT DEFAULT 'text' CHECK (field_type IN ('text', 'number', 'date', 'select', 'email', 'phone', 'textarea')),
  field_category TEXT NOT NULL CHECK (field_category IN ('personal', 'employment', 'statutory', 'banking', 'custom')),
  is_required BOOLEAN DEFAULT false,
  is_visible BOOLEAN DEFAULT true,
  is_system BOOLEAN DEFAULT false,
  display_order INTEGER DEFAULT 0,
  options JSONB DEFAULT NULL,
  placeholder TEXT DEFAULT NULL,
  help_text TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(organization_id, field_key)
);

-- Table to store custom field values for employees
CREATE TABLE IF NOT EXISTS employee_custom_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  field_value TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(employee_id, field_key)
);

-- Enable RLS
ALTER TABLE employee_field_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_custom_fields ENABLE ROW LEVEL SECURITY;

-- RLS Policies for employee_field_configs (using existing helper functions)
CREATE POLICY "Users can view field configs for their organization"
ON employee_field_configs FOR SELECT
USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "Admins can insert field configs"
ON employee_field_configs FOR INSERT
WITH CHECK (
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  AND public.has_role(auth.uid(), organization_id, 'admin')
);

CREATE POLICY "Admins can update field configs"
ON employee_field_configs FOR UPDATE
USING (
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  AND public.has_role(auth.uid(), organization_id, 'admin')
);

CREATE POLICY "Admins can delete field configs"
ON employee_field_configs FOR DELETE
USING (
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  AND public.has_role(auth.uid(), organization_id, 'admin')
);

-- RLS Policies for employee_custom_fields
CREATE POLICY "Users can view custom fields for their organization employees"
ON employee_custom_fields FOR SELECT
USING (
  employee_id IN (
    SELECT e.id FROM employees e
    WHERE e.organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  )
);

CREATE POLICY "Users can insert custom fields for their organization employees"
ON employee_custom_fields FOR INSERT
WITH CHECK (
  employee_id IN (
    SELECT e.id FROM employees e
    WHERE e.organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  )
);

CREATE POLICY "Users can update custom fields for their organization employees"
ON employee_custom_fields FOR UPDATE
USING (
  employee_id IN (
    SELECT e.id FROM employees e
    WHERE e.organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  )
);

CREATE POLICY "Users can delete custom fields for their organization employees"
ON employee_custom_fields FOR DELETE
USING (
  employee_id IN (
    SELECT e.id FROM employees e
    WHERE e.organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  )
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_employee_field_configs_org ON employee_field_configs(organization_id);
CREATE INDEX IF NOT EXISTS idx_employee_custom_fields_employee ON employee_custom_fields(employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_custom_fields_key ON employee_custom_fields(field_key);

-- Phase 3: Add eTIMS columns to invoices table
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS etims_cu_number TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS etims_signature TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS etims_transmitted_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS etims_verification_url TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS etims_qr_code_data TEXT;

-- Add comments for eTIMS columns
COMMENT ON COLUMN invoices.etims_cu_number IS 'KRA eTIMS Control Unit Invoice Number';
COMMENT ON COLUMN invoices.etims_signature IS 'Digital signature returned by KRA';
COMMENT ON COLUMN invoices.etims_transmitted_at IS 'Timestamp when invoice was transmitted to KRA';
COMMENT ON COLUMN invoices.etims_verification_url IS 'URL for verifying invoice on KRA portal';
COMMENT ON COLUMN invoices.etims_qr_code_data IS 'Data encoded in the eTIMS QR code';

-- Create function to update timestamps
CREATE OR REPLACE FUNCTION update_employee_field_configs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE OR REPLACE FUNCTION update_employee_custom_fields_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Create triggers
DROP TRIGGER IF EXISTS update_employee_field_configs_updated_at ON employee_field_configs;
CREATE TRIGGER update_employee_field_configs_updated_at
BEFORE UPDATE ON employee_field_configs
FOR EACH ROW EXECUTE FUNCTION update_employee_field_configs_updated_at();

DROP TRIGGER IF EXISTS update_employee_custom_fields_updated_at ON employee_custom_fields;
CREATE TRIGGER update_employee_custom_fields_updated_at
BEFORE UPDATE ON employee_custom_fields
FOR EACH ROW EXECUTE FUNCTION update_employee_custom_fields_updated_at();
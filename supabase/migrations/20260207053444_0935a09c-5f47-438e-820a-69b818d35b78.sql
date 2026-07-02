-- Create payment method type enum
CREATE TYPE payment_method_type AS ENUM ('bank', 'mobile_money', 'online', 'cash', 'crypto');

-- Create organization_payment_methods table
CREATE TABLE organization_payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  type payment_method_type NOT NULL,
  label text NOT NULL,
  details jsonb DEFAULT '{}' NOT NULL,
  is_default boolean DEFAULT false,
  is_active boolean DEFAULT true,
  display_order integer DEFAULT 0,
  qr_code_enabled boolean DEFAULT false,
  bank_account_id uuid REFERENCES bank_accounts(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

-- Add indexes
CREATE INDEX idx_org_payment_methods_org ON organization_payment_methods(organization_id);
CREATE INDEX idx_org_payment_methods_type ON organization_payment_methods(type);
CREATE INDEX idx_org_payment_methods_active ON organization_payment_methods(is_active) WHERE is_active = true;

-- Add columns to document_templates
ALTER TABLE document_templates 
ADD COLUMN IF NOT EXISTS payment_method_ids uuid[] DEFAULT '{}',
ADD COLUMN IF NOT EXISTS show_payment_methods boolean DEFAULT true;

-- Enable RLS
ALTER TABLE organization_payment_methods ENABLE ROW LEVEL SECURITY;

-- RLS Policies using project's standard pattern (get_user_organization_ids)
CREATE POLICY "Users can view own org payment methods"
  ON organization_payment_methods FOR SELECT
  USING (organization_id = ANY(get_user_organization_ids()));

CREATE POLICY "Users can insert payment methods for own org"
  ON organization_payment_methods FOR INSERT
  WITH CHECK (organization_id = ANY(get_user_organization_ids()));

CREATE POLICY "Users can update own org payment methods"
  ON organization_payment_methods FOR UPDATE
  USING (organization_id = ANY(get_user_organization_ids()));

CREATE POLICY "Users can delete own org payment methods"
  ON organization_payment_methods FOR DELETE
  USING (organization_id = ANY(get_user_organization_ids()));

-- Trigger to update updated_at
CREATE TRIGGER update_org_payment_methods_updated_at
  BEFORE UPDATE ON organization_payment_methods
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Migrate existing bank_details to payment methods using INSERT...SELECT
INSERT INTO organization_payment_methods (organization_id, type, label, details, is_default)
SELECT DISTINCT ON (dt.organization_id)
  dt.organization_id,
  'bank'::payment_method_type,
  COALESCE(
    (dt.bank_details->>'bank_name') || ' - ' || (dt.bank_details->>'account_name'),
    'Bank Account'
  ),
  dt.bank_details,
  true
FROM document_templates dt
WHERE dt.bank_details IS NOT NULL 
  AND dt.bank_details != '{}'::jsonb
  AND dt.organization_id IS NOT NULL
  AND jsonb_typeof(dt.bank_details) = 'object';

-- Update document_templates with the new payment method IDs
UPDATE document_templates dt
SET 
  payment_method_ids = ARRAY(
    SELECT opm.id 
    FROM organization_payment_methods opm 
    WHERE opm.organization_id = dt.organization_id
  ),
  show_payment_methods = COALESCE(dt.show_bank_details, true)
WHERE dt.organization_id IS NOT NULL;
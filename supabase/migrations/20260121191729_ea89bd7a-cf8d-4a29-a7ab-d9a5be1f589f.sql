-- Add tax metadata columns to pos_transaction_items for compliance
-- This ensures we snapshot tax configuration at time of sale

ALTER TABLE pos_transaction_items
ADD COLUMN IF NOT EXISTS tax_rate_id UUID REFERENCES tax_rates(id),
ADD COLUMN IF NOT EXISTS etims_tax_code VARCHAR(1);

COMMENT ON COLUMN pos_transaction_items.tax_rate_id IS 'Reference to tax rate used at time of sale';
COMMENT ON COLUMN pos_transaction_items.etims_tax_code IS 'eTIMS tax code snapshot (A/B/C/D/E) at time of sale';

-- Add index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_pos_transaction_items_tax_rate_id 
ON pos_transaction_items(tax_rate_id) 
WHERE tax_rate_id IS NOT NULL;
-- Add eTIMS tax code mapping to tax_rates table
ALTER TABLE tax_rates 
ADD COLUMN IF NOT EXISTS etims_tax_code VARCHAR(1) CHECK (etims_tax_code IS NULL OR etims_tax_code IN ('A', 'B', 'C', 'D', 'E'));

COMMENT ON COLUMN tax_rates.etims_tax_code IS 'KRA eTIMS tax type code: A=16% VAT, B=0% Zero-rated, C=Exempt, D=8% Reduced, E=Tourism Levy';

-- Add eTIMS fields to invoice_items for tracking transmitted codes
ALTER TABLE invoice_items
ADD COLUMN IF NOT EXISTS etims_tax_code VARCHAR(1),
ADD COLUMN IF NOT EXISTS etims_classification_code TEXT;

COMMENT ON COLUMN invoice_items.etims_tax_code IS 'eTIMS tax type code used at time of transmission';
COMMENT ON COLUMN invoice_items.etims_classification_code IS 'eTIMS item classification code used at time of transmission';

-- Add eTIMS fields to products for configuration
ALTER TABLE products
ADD COLUMN IF NOT EXISTS tax_rate_id UUID REFERENCES tax_rates(id),
ADD COLUMN IF NOT EXISTS etims_classification_code TEXT,
ADD COLUMN IF NOT EXISTS etims_unit_code VARCHAR(10) DEFAULT 'U',
ADD COLUMN IF NOT EXISTS etims_packaging_unit VARCHAR(10) DEFAULT 'CT',
ADD COLUMN IF NOT EXISTS etims_country_origin VARCHAR(2) DEFAULT 'KE';

COMMENT ON COLUMN products.tax_rate_id IS 'Reference to tax rate for eTIMS tax code mapping';
COMMENT ON COLUMN products.etims_classification_code IS 'UNSPSC classification code for eTIMS';
COMMENT ON COLUMN products.etims_unit_code IS 'eTIMS quantity unit code (U=Unit, KG=Kilogram, etc.)';
COMMENT ON COLUMN products.etims_packaging_unit IS 'eTIMS packaging unit code (CT=Carton, BG=Bag, etc.)';
COMMENT ON COLUMN products.etims_country_origin IS 'ISO 2-letter country code for origin';

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_products_tax_rate_id ON products(tax_rate_id);
CREATE INDEX IF NOT EXISTS idx_products_etims_classification ON products(etims_classification_code) WHERE etims_classification_code IS NOT NULL;
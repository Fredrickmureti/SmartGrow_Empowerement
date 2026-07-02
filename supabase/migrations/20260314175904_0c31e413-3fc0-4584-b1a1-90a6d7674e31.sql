
-- Add per-product default GL account mappings
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS sales_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cogs_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS inventory_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;

COMMENT ON COLUMN products.sales_account_id IS 'Default revenue account for this product. Falls back to system default Sales Revenue if NULL.';
COMMENT ON COLUMN products.cogs_account_id IS 'Default COGS account. Falls back to system default COGS if NULL.';
COMMENT ON COLUMN products.inventory_account_id IS 'Default inventory asset account. Falls back to system default Inventory if NULL.';

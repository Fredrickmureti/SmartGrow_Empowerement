-- Continue from Phase 3 onwards (Phase 1-2 already applied)

-- Create price_lists table
CREATE TABLE IF NOT EXISTS price_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  is_default BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  valid_from TIMESTAMPTZ,
  valid_to TIMESTAMPTZ,
  applies_to_branches UUID[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS on price_lists
ALTER TABLE price_lists ENABLE ROW LEVEL SECURITY;

-- Drop policies if they exist then recreate
DROP POLICY IF EXISTS "Users can view price lists in their organization" ON price_lists;
DROP POLICY IF EXISTS "Users can manage price lists in their organization" ON price_lists;

CREATE POLICY "Users can view price lists in their organization"
ON price_lists FOR SELECT
USING (organization_id = ANY(get_user_organization_ids()));

CREATE POLICY "Users can manage price lists in their organization"
ON price_lists FOR ALL
USING (organization_id = ANY(get_user_organization_ids()));

-- Create price_list_items table
CREATE TABLE IF NOT EXISTS price_list_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  price_list_id UUID NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  unit_price NUMERIC NOT NULL,
  min_quantity NUMERIC DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(price_list_id, product_id, min_quantity)
);

-- Enable RLS on price_list_items
ALTER TABLE price_list_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view price list items through price lists" ON price_list_items;
DROP POLICY IF EXISTS "Users can manage price list items through price lists" ON price_list_items;

CREATE POLICY "Users can view price list items through price lists"
ON price_list_items FOR SELECT
USING (price_list_id IN (
  SELECT id FROM price_lists WHERE organization_id = ANY(get_user_organization_ids())
));

CREATE POLICY "Users can manage price list items through price lists"
ON price_list_items FOR ALL
USING (price_list_id IN (
  SELECT id FROM price_lists WHERE organization_id = ANY(get_user_organization_ids())
));

-- Create promotions table
CREATE TABLE IF NOT EXISTS promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  promotion_type TEXT NOT NULL CHECK (promotion_type IN ('percentage', 'fixed_amount', 'buy_x_get_y', 'bundle', 'tiered')),
  discount_value NUMERIC,
  buy_quantity INTEGER,
  get_quantity INTEGER,
  bundle_price NUMERIC,
  conditions JSONB DEFAULT '{}',
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ NOT NULL,
  is_active BOOLEAN DEFAULT true,
  applies_to TEXT DEFAULT 'all' CHECK (applies_to IN ('all', 'category', 'product', 'customer_group')),
  target_ids UUID[],
  min_purchase_amount NUMERIC,
  max_discount_amount NUMERIC,
  usage_limit INTEGER,
  usage_count INTEGER DEFAULT 0,
  promo_code TEXT,
  stackable BOOLEAN DEFAULT false,
  priority INTEGER DEFAULT 0,
  applies_to_branches UUID[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS on promotions
ALTER TABLE promotions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view promotions in their organization" ON promotions;
DROP POLICY IF EXISTS "Users can manage promotions in their organization" ON promotions;

CREATE POLICY "Users can view promotions in their organization"
ON promotions FOR SELECT
USING (organization_id = ANY(get_user_organization_ids()));

CREATE POLICY "Users can manage promotions in their organization"
ON promotions FOR ALL
USING (organization_id = ANY(get_user_organization_ids()));

-- Create triggers if not exist
DROP TRIGGER IF EXISTS update_promotions_updated_at ON promotions;
CREATE TRIGGER update_promotions_updated_at
BEFORE UPDATE ON promotions
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_price_lists_updated_at ON price_lists;
CREATE TRIGGER update_price_lists_updated_at
BEFORE UPDATE ON price_lists
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- PHASE 4: Weighted Items & Produce
-- =====================================================

-- Add weighted item columns to products (safe with IF NOT EXISTS)
ALTER TABLE products
ADD COLUMN IF NOT EXISTS is_weighted BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS price_per_unit NUMERIC,
ADD COLUMN IF NOT EXISTS weight_unit TEXT DEFAULT 'kg',
ADD COLUMN IF NOT EXISTS plu_code TEXT,
ADD COLUMN IF NOT EXISTS tare_weight NUMERIC DEFAULT 0;

-- Create index for PLU code lookups
CREATE INDEX IF NOT EXISTS idx_products_plu_code ON products(plu_code) WHERE plu_code IS NOT NULL;

-- =====================================================
-- PHASE 5: Manager Controls & Approvals
-- =====================================================

-- Create POS approval requests table
CREATE TABLE IF NOT EXISTS pos_approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  transaction_id UUID REFERENCES pos_transactions(id) ON DELETE SET NULL,
  register_id UUID REFERENCES pos_registers(id) ON DELETE SET NULL,
  approval_type TEXT NOT NULL CHECK (approval_type IN ('void', 'discount', 'price_override', 'refund', 'no_sale', 'manual_discount')),
  requested_by UUID NOT NULL,
  approved_by UUID,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  original_value NUMERIC,
  requested_value NUMERIC,
  reason TEXT,
  details JSONB DEFAULT '{}',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

-- Enable RLS on pos_approval_requests
ALTER TABLE pos_approval_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view approval requests in their organization" ON pos_approval_requests;
DROP POLICY IF EXISTS "Users can create approval requests in their organization" ON pos_approval_requests;
DROP POLICY IF EXISTS "Managers can update approval requests in their organization" ON pos_approval_requests;

CREATE POLICY "Users can view approval requests in their organization"
ON pos_approval_requests FOR SELECT
USING (organization_id = ANY(get_user_organization_ids()));

CREATE POLICY "Users can create approval requests in their organization"
ON pos_approval_requests FOR INSERT
WITH CHECK (organization_id = ANY(get_user_organization_ids()));

CREATE POLICY "Managers can update approval requests in their organization"
ON pos_approval_requests FOR UPDATE
USING (organization_id = ANY(get_user_organization_ids()));

-- Add manager override settings to pos_settings
ALTER TABLE pos_settings
ADD COLUMN IF NOT EXISTS max_discount_percent NUMERIC DEFAULT 100,
ADD COLUMN IF NOT EXISTS max_void_amount NUMERIC,
ADD COLUMN IF NOT EXISTS require_manager_for_void BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS require_manager_for_refund BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS require_manager_for_discount_above NUMERIC,
ADD COLUMN IF NOT EXISTS manager_pin_enabled BOOLEAN DEFAULT false;

-- Create product_categories table
CREATE TABLE public.product_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  parent_id UUID REFERENCES product_categories(id) ON DELETE SET NULL,
  color TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Add category_id to products
ALTER TABLE public.products
  ADD COLUMN category_id UUID REFERENCES product_categories(id) ON DELETE SET NULL;

-- RLS
ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view product categories in their org"
  ON public.product_categories FOR SELECT
  USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can create product categories in their org"
  ON public.product_categories FOR INSERT
  WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update product categories in their org"
  ON public.product_categories FOR UPDATE
  USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete product categories in their org"
  ON public.product_categories FOR DELETE
  USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

-- Indexes
CREATE INDEX idx_product_categories_org ON product_categories(organization_id);
CREATE INDEX idx_products_category ON products(category_id);

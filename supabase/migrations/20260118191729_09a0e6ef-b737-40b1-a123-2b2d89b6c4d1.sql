-- Phase 4: Backorder Management

-- Add backorder fields to sales_order_items
ALTER TABLE public.sales_order_items
ADD COLUMN IF NOT EXISTS quantity_backordered NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS backorder_eta DATE;

-- Create backorders table
CREATE TABLE IF NOT EXISTS public.backorders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  sales_order_id UUID NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  sales_order_item_id UUID NOT NULL REFERENCES public.sales_order_items(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  quantity NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'allocated', 'fulfilled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  allocated_at TIMESTAMPTZ,
  fulfilled_at TIMESTAMPTZ
);

-- Enable RLS
ALTER TABLE public.backorders ENABLE ROW LEVEL SECURITY;

-- Create RLS policies using user_roles table
CREATE POLICY "Users can view backorders for their organization" 
ON public.backorders FOR SELECT 
USING (organization_id IN (
  SELECT organization_id FROM user_roles WHERE user_id = auth.uid()
));

CREATE POLICY "Users can create backorders for their organization" 
ON public.backorders FOR INSERT 
WITH CHECK (organization_id IN (
  SELECT organization_id FROM user_roles WHERE user_id = auth.uid()
));

CREATE POLICY "Users can update backorders for their organization" 
ON public.backorders FOR UPDATE 
USING (organization_id IN (
  SELECT organization_id FROM user_roles WHERE user_id = auth.uid()
));

CREATE POLICY "Users can delete backorders for their organization" 
ON public.backorders FOR DELETE 
USING (organization_id IN (
  SELECT organization_id FROM user_roles WHERE user_id = auth.uid()
));

-- Add indexes
CREATE INDEX IF NOT EXISTS idx_backorders_org ON public.backorders(organization_id);
CREATE INDEX IF NOT EXISTS idx_backorders_product ON public.backorders(product_id);
CREATE INDEX IF NOT EXISTS idx_backorders_status ON public.backorders(status);
CREATE INDEX IF NOT EXISTS idx_backorders_sales_order ON public.backorders(sales_order_id);
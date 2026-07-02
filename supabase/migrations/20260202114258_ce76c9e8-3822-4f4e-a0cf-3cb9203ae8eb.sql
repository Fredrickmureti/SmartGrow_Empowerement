-- Phase 2: Create customer_groups table for dynamic grouping
CREATE TABLE public.customer_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  discount_percent NUMERIC(5,2) DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(organization_id, name)
);

-- Enable RLS
ALTER TABLE public.customer_groups ENABLE ROW LEVEL SECURITY;

-- RLS Policies using the existing get_user_organizations function
CREATE POLICY "Users can view their org's customer groups"
  ON public.customer_groups
  FOR SELECT
  USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can insert customer groups in their org"
  ON public.customer_groups
  FOR INSERT
  WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update their org's customer groups"
  ON public.customer_groups
  FOR UPDATE
  USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete their org's customer groups"
  ON public.customer_groups
  FOR DELETE
  USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

-- Add timestamp update trigger
CREATE TRIGGER update_customer_groups_updated_at
  BEFORE UPDATE ON public.customer_groups
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Phase 4: Add service quotation fields to estimate_items
ALTER TABLE public.estimate_items 
  ADD COLUMN IF NOT EXISTS scope_of_work TEXT,
  ADD COLUMN IF NOT EXISTS deliverables JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS estimated_hours NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(12,2);

-- Add indexes for customer_groups lookup
CREATE INDEX idx_customer_groups_org ON public.customer_groups(organization_id);
CREATE INDEX idx_customer_groups_active ON public.customer_groups(organization_id, is_active) WHERE is_active = true;
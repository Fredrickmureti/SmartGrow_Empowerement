-- Create businesses table
CREATE TABLE public.businesses (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  legal_name TEXT,
  tax_id TEXT,
  registration_number TEXT,
  logo_url TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  country TEXT,
  base_currency TEXT DEFAULT 'USD',
  invoice_prefix TEXT,
  estimate_prefix TEXT,
  bill_prefix TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create branches table
CREATE TABLE public.branches (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  country TEXT,
  is_headquarters BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;

-- RLS Policies for businesses
CREATE POLICY "Users can view businesses in their organizations"
ON public.businesses FOR SELECT
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can create businesses in their organizations"
ON public.businesses FOR INSERT
WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update businesses in their organizations"
ON public.businesses FOR UPDATE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete businesses in their organizations"
ON public.businesses FOR DELETE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

-- RLS Policies for branches
CREATE POLICY "Users can view branches in their organizations"
ON public.branches FOR SELECT
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can create branches in their organizations"
ON public.branches FOR INSERT
WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update branches in their organizations"
ON public.branches FOR UPDATE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete branches in their organizations"
ON public.branches FOR DELETE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

-- Indexes for performance
CREATE INDEX idx_businesses_organization_id ON public.businesses(organization_id);
CREATE INDEX idx_businesses_is_active ON public.businesses(is_active);
CREATE INDEX idx_branches_business_id ON public.branches(business_id);
CREATE INDEX idx_branches_organization_id ON public.branches(organization_id);
CREATE INDEX idx_branches_is_active ON public.branches(is_active);

-- Trigger for updated_at on businesses
CREATE TRIGGER update_businesses_updated_at
BEFORE UPDATE ON public.businesses
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Trigger for updated_at on branches
CREATE TRIGGER update_branches_updated_at
BEFORE UPDATE ON public.branches
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();
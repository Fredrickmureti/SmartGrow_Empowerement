-- Create table for organization payment gateway configurations
CREATE TABLE public.organization_payment_gateways (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE NOT NULL,
    provider TEXT NOT NULL DEFAULT 'stripe',
    display_name TEXT,
    publishable_key TEXT,
    secret_key_encrypted TEXT,
    webhook_secret_encrypted TEXT,
    is_active BOOLEAN DEFAULT false,
    is_test_mode BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    UNIQUE(organization_id, provider)
);

-- Enable RLS
ALTER TABLE public.organization_payment_gateways ENABLE ROW LEVEL SECURITY;

-- RLS policies - only org admins can manage payment gateways
CREATE POLICY "Organization members can view their payment gateways"
ON public.organization_payment_gateways
FOR SELECT
USING (
    public.is_org_member(organization_id, auth.uid())
);

CREATE POLICY "Organization admins can insert payment gateways"
ON public.organization_payment_gateways
FOR INSERT
WITH CHECK (
    public.has_role(auth.uid(), organization_id, 'owner'::app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::app_role)
);

CREATE POLICY "Organization admins can update payment gateways"
ON public.organization_payment_gateways
FOR UPDATE
USING (
    public.has_role(auth.uid(), organization_id, 'owner'::app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::app_role)
);

CREATE POLICY "Organization admins can delete payment gateways"
ON public.organization_payment_gateways
FOR DELETE
USING (
    public.has_role(auth.uid(), organization_id, 'owner'::app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::app_role)
);

-- Create table for API integrations (generic for future integrations)
CREATE TABLE public.organization_api_integrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE NOT NULL,
    integration_type TEXT NOT NULL,
    provider TEXT NOT NULL,
    display_name TEXT,
    api_key_encrypted TEXT,
    api_secret_encrypted TEXT,
    config JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    UNIQUE(organization_id, integration_type, provider)
);

-- Enable RLS
ALTER TABLE public.organization_api_integrations ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Organization members can view their integrations"
ON public.organization_api_integrations
FOR SELECT
USING (
    public.is_org_member(organization_id, auth.uid())
);

CREATE POLICY "Organization admins can insert integrations"
ON public.organization_api_integrations
FOR INSERT
WITH CHECK (
    public.has_role(auth.uid(), organization_id, 'owner'::app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::app_role)
);

CREATE POLICY "Organization admins can update integrations"
ON public.organization_api_integrations
FOR UPDATE
USING (
    public.has_role(auth.uid(), organization_id, 'owner'::app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::app_role)
);

CREATE POLICY "Organization admins can delete integrations"
ON public.organization_api_integrations
FOR DELETE
USING (
    public.has_role(auth.uid(), organization_id, 'owner'::app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::app_role)
);

-- Add payment_link column to invoices
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS payment_link TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS payment_link_expires_at TIMESTAMP WITH TIME ZONE;
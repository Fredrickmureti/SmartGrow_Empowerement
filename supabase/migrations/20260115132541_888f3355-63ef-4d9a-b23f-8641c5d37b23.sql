-- Create POS settings table for receipt and general settings
CREATE TABLE public.pos_settings (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    register_id UUID REFERENCES public.pos_registers(id) ON DELETE CASCADE,
    setting_key TEXT NOT NULL,
    setting_value JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    UNIQUE(organization_id, register_id, setting_key)
);

-- Create POS payment methods table
CREATE TABLE public.pos_payment_methods (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    method_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    is_enabled BOOLEAN DEFAULT true,
    requires_reference BOOLEAN DEFAULT false,
    icon TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    UNIQUE(organization_id, method_key)
);

-- Enable Row Level Security
ALTER TABLE public.pos_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_payment_methods ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for pos_settings using existing is_org_member function
CREATE POLICY "Users can view their organization's POS settings"
ON public.pos_settings
FOR SELECT
USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can manage their organization's POS settings"
ON public.pos_settings
FOR ALL
USING (public.is_org_member(auth.uid(), organization_id));

-- Create RLS policies for pos_payment_methods
CREATE POLICY "Users can view their organization's payment methods"
ON public.pos_payment_methods
FOR SELECT
USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can manage their organization's payment methods"
ON public.pos_payment_methods
FOR ALL
USING (public.is_org_member(auth.uid(), organization_id));

-- Create updated_at triggers
CREATE TRIGGER update_pos_settings_updated_at
    BEFORE UPDATE ON public.pos_settings
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_pos_payment_methods_updated_at
    BEFORE UPDATE ON public.pos_payment_methods
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();
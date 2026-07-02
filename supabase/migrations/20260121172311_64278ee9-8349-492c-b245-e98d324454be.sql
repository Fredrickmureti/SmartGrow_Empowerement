-- Create table for managing eTIMS tax categories (editable by users)
CREATE TABLE public.etims_tax_categories (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    code VARCHAR(5) NOT NULL,
    name VARCHAR(100) NOT NULL,
    rate DECIMAL(5,2) NOT NULL DEFAULT 0,
    description TEXT,
    is_active BOOLEAN DEFAULT true,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    UNIQUE(organization_id, code)
);

-- Enable RLS
ALTER TABLE public.etims_tax_categories ENABLE ROW LEVEL SECURITY;

-- Create policies using user_roles table
CREATE POLICY "Users can view their organization's eTIMS tax categories"
    ON public.etims_tax_categories
    FOR SELECT
    USING (organization_id IN (
        SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    ));

CREATE POLICY "Admins can manage their organization's eTIMS tax categories"
    ON public.etims_tax_categories
    FOR ALL
    USING (organization_id IN (
        SELECT organization_id FROM public.user_roles 
        WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    ));

-- Create index for performance
CREATE INDEX idx_etims_tax_categories_org ON public.etims_tax_categories(organization_id);

-- Create trigger for updated_at
CREATE TRIGGER update_etims_tax_categories_updated_at
    BEFORE UPDATE ON public.etims_tax_categories
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

-- Insert default KRA eTIMS tax categories for existing organizations
INSERT INTO public.etims_tax_categories (organization_id, code, name, rate, description, sort_order)
SELECT 
    o.id,
    t.code,
    t.name,
    t.rate,
    t.description,
    t.sort_order
FROM public.organizations o
CROSS JOIN (
    VALUES 
        ('A', 'VAT 16%', 16.00, 'Standard VAT rate for taxable goods and services', 1),
        ('B', 'VAT 0%', 0.00, 'Zero-rated supplies (exports, basic food, etc.)', 2),
        ('C', 'Exempt', 0.00, 'VAT exempt supplies (education, health, etc.)', 3),
        ('D', 'VAT 8%', 8.00, 'Reduced rate for petroleum products', 4),
        ('E', 'Tourism Levy', 2.00, 'Tourism levy on applicable services', 5)
) AS t(code, name, rate, description, sort_order)
ON CONFLICT (organization_id, code) DO NOTHING;
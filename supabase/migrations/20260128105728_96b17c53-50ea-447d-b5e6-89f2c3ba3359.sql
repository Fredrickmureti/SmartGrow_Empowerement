-- Create document_templates table for customizable invoice/estimate/proforma templates
CREATE TABLE public.document_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE CASCADE,
  template_type TEXT NOT NULL CHECK (template_type IN ('invoice', 'estimate', 'proforma', 'credit_note', 'receipt', 'purchase_order')),
  template_name TEXT NOT NULL,
  is_default BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  
  -- Branding
  logo_position TEXT DEFAULT 'top-left' CHECK (logo_position IN ('top-left', 'top-center', 'top-right')),
  logo_size TEXT DEFAULT 'medium' CHECK (logo_size IN ('small', 'medium', 'large')),
  primary_color TEXT DEFAULT '#1a1a2e',
  secondary_color TEXT DEFAULT '#6b7280',
  accent_color TEXT DEFAULT '#3b82f6',
  font_family TEXT DEFAULT 'Inter',
  font_size_base INTEGER DEFAULT 14 CHECK (font_size_base >= 10 AND font_size_base <= 20),
  
  -- Header settings
  show_company_name BOOLEAN DEFAULT true,
  show_company_address BOOLEAN DEFAULT true,
  show_company_phone BOOLEAN DEFAULT true,
  show_company_email BOOLEAN DEFAULT true,
  show_tax_id BOOLEAN DEFAULT false,
  header_text TEXT,
  document_title_format TEXT DEFAULT 'INVOICE',
  
  -- Content/Items table settings
  show_line_numbers BOOLEAN DEFAULT true,
  show_item_sku BOOLEAN DEFAULT false,
  show_item_description BOOLEAN DEFAULT true,
  show_unit_price BOOLEAN DEFAULT true,
  show_quantity BOOLEAN DEFAULT true,
  show_tax_column BOOLEAN DEFAULT true,
  show_discount_column BOOLEAN DEFAULT false,
  show_subtotals_per_item BOOLEAN DEFAULT false,
  columns_layout JSONB DEFAULT '{"description": 40, "quantity": 10, "unit_price": 15, "tax": 10, "amount": 15}'::jsonb,
  
  -- Totals settings
  show_subtotal BOOLEAN DEFAULT true,
  show_discount_total BOOLEAN DEFAULT true,
  show_tax_breakdown BOOLEAN DEFAULT true,
  show_total_in_words BOOLEAN DEFAULT false,
  totals_position TEXT DEFAULT 'right' CHECK (totals_position IN ('right', 'center', 'full-width')),
  
  -- Footer settings
  show_payment_instructions BOOLEAN DEFAULT true,
  payment_instructions TEXT,
  bank_details JSONB DEFAULT '{}'::jsonb,
  show_bank_details BOOLEAN DEFAULT true,
  footer_text TEXT,
  show_signature_line BOOLEAN DEFAULT false,
  signature_label TEXT DEFAULT 'Authorized Signature',
  show_terms BOOLEAN DEFAULT true,
  terms_text TEXT,
  
  -- Advanced settings
  watermark_text TEXT,
  watermark_opacity NUMERIC DEFAULT 0.1,
  background_color TEXT DEFAULT '#ffffff',
  custom_css TEXT,
  
  -- Timestamps
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create index for faster lookups
CREATE INDEX idx_document_templates_org ON public.document_templates(organization_id);
CREATE INDEX idx_document_templates_business ON public.document_templates(business_id);
CREATE INDEX idx_document_templates_type ON public.document_templates(template_type);
CREATE INDEX idx_document_templates_default ON public.document_templates(organization_id, template_type, is_default) WHERE is_default = true;

-- Enable RLS
ALTER TABLE public.document_templates ENABLE ROW LEVEL SECURITY;

-- Create security definer function to check organization membership
CREATE OR REPLACE FUNCTION public.user_belongs_to_org(_user_id UUID, _org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND organization_id = _org_id
  )
$$;

-- RLS Policies
CREATE POLICY "Users can view templates in their organization"
ON public.document_templates
FOR SELECT
TO authenticated
USING (public.user_belongs_to_org(auth.uid(), organization_id));

CREATE POLICY "Users can create templates in their organization"
ON public.document_templates
FOR INSERT
TO authenticated
WITH CHECK (public.user_belongs_to_org(auth.uid(), organization_id));

CREATE POLICY "Users can update templates in their organization"
ON public.document_templates
FOR UPDATE
TO authenticated
USING (public.user_belongs_to_org(auth.uid(), organization_id));

CREATE POLICY "Users can delete templates in their organization"
ON public.document_templates
FOR DELETE
TO authenticated
USING (public.user_belongs_to_org(auth.uid(), organization_id));

-- Add template_id to invoices table
ALTER TABLE public.invoices 
ADD COLUMN IF NOT EXISTS template_id UUID REFERENCES public.document_templates(id) ON DELETE SET NULL;

-- Add template_id to estimates table
ALTER TABLE public.estimates 
ADD COLUMN IF NOT EXISTS template_id UUID REFERENCES public.document_templates(id) ON DELETE SET NULL;

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION public.update_document_templates_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_document_templates_timestamp
BEFORE UPDATE ON public.document_templates
FOR EACH ROW EXECUTE FUNCTION public.update_document_templates_updated_at();

-- Function to ensure only one default template per type per org/business
CREATE OR REPLACE FUNCTION public.ensure_single_default_template()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_default = true THEN
    -- Unset other defaults for same type in same org/business scope
    UPDATE public.document_templates
    SET is_default = false
    WHERE id != NEW.id
      AND organization_id = NEW.organization_id
      AND template_type = NEW.template_type
      AND is_default = true
      AND (
        (NEW.business_id IS NULL AND business_id IS NULL)
        OR (NEW.business_id IS NOT NULL AND business_id = NEW.business_id)
      );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ensure_single_default_template_trigger
BEFORE INSERT OR UPDATE ON public.document_templates
FOR EACH ROW EXECUTE FUNCTION public.ensure_single_default_template();
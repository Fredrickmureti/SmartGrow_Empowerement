
-- ============================================================
-- Phase 3: Tax Reporting Framework
-- ============================================================

-- Tax report templates (e.g., VAT Return, GST Return)
CREATE TABLE IF NOT EXISTS public.tax_report_templates (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  country_code text,
  report_type text NOT NULL DEFAULT 'vat_return',
  is_active boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tax_report_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view tax report templates in their orgs"
  ON public.tax_report_templates FOR SELECT
  USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can manage tax report templates in their orgs"
  ON public.tax_report_templates FOR ALL
  USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

-- Tax report template lines (configurable line definitions)
CREATE TABLE IF NOT EXISTS public.tax_report_template_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  template_id uuid NOT NULL REFERENCES public.tax_report_templates(id) ON DELETE CASCADE,
  line_number text NOT NULL,
  label text NOT NULL,
  description text,
  line_type text NOT NULL DEFAULT 'tax_amount' CHECK (line_type IN ('tax_amount', 'base_amount', 'subtotal', 'total', 'formula')),
  tax_rate_ids uuid[] DEFAULT '{}',
  account_ids uuid[] DEFAULT '{}',
  formula text,
  sort_order integer NOT NULL DEFAULT 0,
  is_bold boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tax_report_template_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view tax report lines via template"
  ON public.tax_report_template_lines FOR SELECT
  USING (template_id IN (
    SELECT id FROM public.tax_report_templates 
    WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
  ));

CREATE POLICY "Users can manage tax report lines via template"
  ON public.tax_report_template_lines FOR ALL
  USING (template_id IN (
    SELECT id FROM public.tax_report_templates 
    WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
  ));

-- ============================================================
-- Phase 4: Withholding Tax & Contact-Level Tax Rules
-- ============================================================

-- Add tax-related fields to contacts for withholding tax
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS withholding_tax_rate numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_exemption_number text,
  ADD COLUMN IF NOT EXISTS tax_exemption_expiry date,
  ADD COLUMN IF NOT EXISTS default_tax_rate_id uuid REFERENCES public.tax_rates(id);

COMMENT ON COLUMN public.contacts.withholding_tax_rate IS 'Withholding tax rate for this contact (0 = none)';
COMMENT ON COLUMN public.contacts.tax_exemption_number IS 'Tax exemption certificate number';
COMMENT ON COLUMN public.contacts.tax_exemption_expiry IS 'Tax exemption certificate expiry date';
COMMENT ON COLUMN public.contacts.default_tax_rate_id IS 'Default tax rate to apply for transactions with this contact';

-- Add tax_tag to journal_entry_lines for tax report population
ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS tax_rate_id uuid REFERENCES public.tax_rates(id),
  ADD COLUMN IF NOT EXISTS tax_tag text;

COMMENT ON COLUMN public.journal_entry_lines.tax_rate_id IS 'Reference to the tax rate that generated this line';
COMMENT ON COLUMN public.journal_entry_lines.tax_tag IS 'Tax tag for automatic tax report population';

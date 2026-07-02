-- =====================================================
-- Phase 1: eTIMS Database Schema Extensions
-- =====================================================

-- 1.1 Create Tax Compliance Configuration Table
-- This stores credentials and settings for country-specific tax systems
CREATE TABLE IF NOT EXISTS public.tax_compliance_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  country_code TEXT NOT NULL,
  provider TEXT NOT NULL, -- 'kra_etims', 'ura_efris' (future Uganda), etc.
  is_active BOOLEAN DEFAULT false,
  is_test_mode BOOLEAN DEFAULT true,
  config JSONB DEFAULT '{}', -- Stores encrypted credentials like communication_key, tin, bhf_id
  device_serial TEXT, -- OSCU device serial number
  last_sync_at TIMESTAMPTZ,
  sync_status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(organization_id, country_code, provider)
);

-- Enable RLS
ALTER TABLE public.tax_compliance_configs ENABLE ROW LEVEL SECURITY;

-- RLS Policies for tax_compliance_configs
CREATE POLICY "Users can view their organization's tax compliance configs"
  ON public.tax_compliance_configs FOR SELECT
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Owners and admins can manage tax compliance configs"
  ON public.tax_compliance_configs FOR ALL
  USING (public.has_any_org_role(auth.uid(), organization_id, ARRAY['owner', 'admin']::app_role[]));

-- 1.2 Create eTIMS Standard Codes Cache Table
-- Caches KRA standard codes for item classification, tax types, units, etc.
CREATE TABLE IF NOT EXISTS public.etims_standard_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_type TEXT NOT NULL, -- 'item_classification', 'tax_type', 'unit_of_measure', 'country', 'currency', 'packaging_unit'
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  name_local TEXT, -- Swahili or local language name
  description TEXT,
  parent_code TEXT,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  fetched_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(code_type, code)
);

-- Enable RLS (public read access for standard codes)
ALTER TABLE public.etims_standard_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read standard codes"
  ON public.etims_standard_codes FOR SELECT
  USING (true);

CREATE POLICY "Only platform admins can manage standard codes"
  ON public.etims_standard_codes FOR ALL
  USING (public.is_platform_admin(auth.uid()));

-- 1.3 Extend Products Table for eTIMS Item Registration
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS etims_item_code TEXT;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS etims_classification_code TEXT;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS etims_unit_code TEXT DEFAULT 'U';
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS etims_packaging_unit TEXT DEFAULT 'CT';
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS etims_origin_country TEXT DEFAULT 'KE';
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS etims_registered_at TIMESTAMPTZ;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS etims_registration_status TEXT DEFAULT 'pending';

-- 1.4 Extend Invoices Table for eTIMS Response Data
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS etims_cu_number TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS etims_qr_code_url TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS etims_internal_data TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS etims_receipt_signature TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS etims_receipt_number BIGINT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS etims_transmitted_at TIMESTAMPTZ;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS etims_transmission_status TEXT DEFAULT 'pending';
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS etims_error_message TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS etims_sdc_id TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS etims_mrc_number TEXT;

-- 1.5 Extend Credit Notes Table for eTIMS Response Data
ALTER TABLE public.credit_notes ADD COLUMN IF NOT EXISTS etims_cu_number TEXT;
ALTER TABLE public.credit_notes ADD COLUMN IF NOT EXISTS etims_qr_code_url TEXT;
ALTER TABLE public.credit_notes ADD COLUMN IF NOT EXISTS etims_transmitted_at TIMESTAMPTZ;
ALTER TABLE public.credit_notes ADD COLUMN IF NOT EXISTS etims_transmission_status TEXT DEFAULT 'pending';
ALTER TABLE public.credit_notes ADD COLUMN IF NOT EXISTS etims_error_message TEXT;
ALTER TABLE public.credit_notes ADD COLUMN IF NOT EXISTS etims_original_invoice_number TEXT;

-- 1.6 Create eTIMS Transmission Log Table
-- Audit trail for all eTIMS API communications
CREATE TABLE IF NOT EXISTS public.etims_transmission_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL, -- 'invoice', 'credit_note', 'item', 'stock_master', 'stock_io'
  document_id UUID NOT NULL,
  document_number TEXT,
  api_endpoint TEXT NOT NULL,
  request_payload JSONB,
  response_payload JSONB,
  response_code TEXT,
  response_message TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'success', 'failed', 'retrying'
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  next_retry_at TIMESTAMPTZ,
  transmitted_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.etims_transmission_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their organization's transmission logs"
  ON public.etims_transmission_logs FOR SELECT
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "System can insert transmission logs"
  ON public.etims_transmission_logs FOR INSERT
  WITH CHECK (public.is_org_member(auth.uid(), organization_id));

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_tax_compliance_configs_org ON public.tax_compliance_configs(organization_id);
CREATE INDEX IF NOT EXISTS idx_tax_compliance_configs_country ON public.tax_compliance_configs(country_code, provider);
CREATE INDEX IF NOT EXISTS idx_etims_standard_codes_type ON public.etims_standard_codes(code_type);
CREATE INDEX IF NOT EXISTS idx_etims_standard_codes_parent ON public.etims_standard_codes(parent_code);
CREATE INDEX IF NOT EXISTS idx_etims_transmission_logs_org ON public.etims_transmission_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_etims_transmission_logs_status ON public.etims_transmission_logs(status);
CREATE INDEX IF NOT EXISTS idx_etims_transmission_logs_doc ON public.etims_transmission_logs(document_type, document_id);
CREATE INDEX IF NOT EXISTS idx_products_etims_code ON public.products(etims_item_code);
CREATE INDEX IF NOT EXISTS idx_invoices_etims_status ON public.invoices(etims_transmission_status);

-- Add trigger for updated_at
CREATE TRIGGER update_tax_compliance_configs_updated_at
  BEFORE UPDATE ON public.tax_compliance_configs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
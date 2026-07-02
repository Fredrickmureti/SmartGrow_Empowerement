-- =============================================
-- PHASE 1: MULTI-CURRENCY & TAX CONFIGURATION
-- =============================================

-- Currencies table for supported currencies
CREATE TABLE public.currencies (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  code TEXT NOT NULL UNIQUE, -- ISO 4217 code (USD, EUR, KES, etc.)
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  decimal_places INTEGER DEFAULT 2,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Insert common currencies
INSERT INTO public.currencies (code, name, symbol, decimal_places) VALUES
  ('USD', 'US Dollar', '$', 2),
  ('EUR', 'Euro', '€', 2),
  ('GBP', 'British Pound', '£', 2),
  ('KES', 'Kenyan Shilling', 'KSh', 2),
  ('NGN', 'Nigerian Naira', '₦', 2),
  ('ZAR', 'South African Rand', 'R', 2),
  ('INR', 'Indian Rupee', '₹', 2),
  ('AUD', 'Australian Dollar', 'A$', 2),
  ('CAD', 'Canadian Dollar', 'C$', 2),
  ('JPY', 'Japanese Yen', '¥', 0),
  ('CNY', 'Chinese Yuan', '¥', 2),
  ('CHF', 'Swiss Franc', 'CHF', 2),
  ('AED', 'UAE Dirham', 'د.إ', 2),
  ('SAR', 'Saudi Riyal', '﷼', 2),
  ('BRL', 'Brazilian Real', 'R$', 2),
  ('MXN', 'Mexican Peso', '$', 2),
  ('SGD', 'Singapore Dollar', 'S$', 2),
  ('HKD', 'Hong Kong Dollar', 'HK$', 2),
  ('NZD', 'New Zealand Dollar', 'NZ$', 2),
  ('SEK', 'Swedish Krona', 'kr', 2),
  ('NOK', 'Norwegian Krone', 'kr', 2),
  ('DKK', 'Danish Krone', 'kr', 2),
  ('TZS', 'Tanzanian Shilling', 'TSh', 2),
  ('UGX', 'Ugandan Shilling', 'USh', 0),
  ('GHS', 'Ghanaian Cedi', 'GH₵', 2),
  ('EGP', 'Egyptian Pound', 'E£', 2),
  ('PKR', 'Pakistani Rupee', '₨', 2),
  ('BDT', 'Bangladeshi Taka', '৳', 2),
  ('PHP', 'Philippine Peso', '₱', 2),
  ('IDR', 'Indonesian Rupiah', 'Rp', 0),
  ('MYR', 'Malaysian Ringgit', 'RM', 2),
  ('THB', 'Thai Baht', '฿', 2),
  ('VND', 'Vietnamese Dong', '₫', 0),
  ('KRW', 'South Korean Won', '₩', 0),
  ('TWD', 'Taiwan Dollar', 'NT$', 2),
  ('RUB', 'Russian Ruble', '₽', 2),
  ('PLN', 'Polish Zloty', 'zł', 2),
  ('TRY', 'Turkish Lira', '₺', 2),
  ('ILS', 'Israeli Shekel', '₪', 2),
  ('COP', 'Colombian Peso', '$', 2),
  ('ARS', 'Argentine Peso', '$', 2),
  ('CLP', 'Chilean Peso', '$', 0),
  ('PEN', 'Peruvian Sol', 'S/', 2);

-- Exchange rates table
CREATE TABLE public.exchange_rates (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  from_currency TEXT NOT NULL,
  to_currency TEXT NOT NULL,
  rate NUMERIC(18, 8) NOT NULL,
  effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(organization_id, from_currency, to_currency, effective_date)
);

-- Tax rates table
CREATE TABLE public.tax_rates (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  rate NUMERIC(5, 2) NOT NULL, -- e.g., 16.00 for 16%
  description TEXT,
  is_compound BOOLEAN DEFAULT false, -- applies on top of other taxes
  is_inclusive BOOLEAN DEFAULT false, -- tax included in price
  is_default BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tax groups for composite taxes (e.g., GST = CGST + SGST)
CREATE TABLE public.tax_groups (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tax group items (links tax rates to groups)
CREATE TABLE public.tax_group_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tax_group_id UUID NOT NULL REFERENCES public.tax_groups(id) ON DELETE CASCADE,
  tax_rate_id UUID NOT NULL REFERENCES public.tax_rates(id) ON DELETE CASCADE,
  sort_order INTEGER DEFAULT 0,
  UNIQUE(tax_group_id, tax_rate_id)
);

-- Add organization settings for localization
ALTER TABLE public.organizations 
  ADD COLUMN IF NOT EXISTS date_format TEXT DEFAULT 'MM/DD/YYYY',
  ADD COLUMN IF NOT EXISTS number_format TEXT DEFAULT 'en-US',
  ADD COLUMN IF NOT EXISTS invoice_prefix TEXT DEFAULT 'INV',
  ADD COLUMN IF NOT EXISTS estimate_prefix TEXT DEFAULT 'EST',
  ADD COLUMN IF NOT EXISTS bill_prefix TEXT DEFAULT 'BILL',
  ADD COLUMN IF NOT EXISTS credit_note_prefix TEXT DEFAULT 'CN',
  ADD COLUMN IF NOT EXISTS default_payment_terms INTEGER DEFAULT 30,
  ADD COLUMN IF NOT EXISTS default_tax_rate_id UUID REFERENCES public.tax_rates(id);

-- Enable RLS on new tables
ALTER TABLE public.currencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exchange_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_group_items ENABLE ROW LEVEL SECURITY;

-- Currencies are public read
CREATE POLICY "Anyone can view currencies" ON public.currencies FOR SELECT USING (true);

-- Exchange rates policies
CREATE POLICY "Users can view exchange rates in their orgs" ON public.exchange_rates
  FOR SELECT USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can manage exchange rates in their orgs" ON public.exchange_rates
  FOR ALL USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

-- Tax rates policies
CREATE POLICY "Users can view tax rates in their orgs" ON public.tax_rates
  FOR SELECT USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can manage tax rates in their orgs" ON public.tax_rates
  FOR ALL USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

-- Tax groups policies
CREATE POLICY "Users can view tax groups in their orgs" ON public.tax_groups
  FOR SELECT USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can manage tax groups in their orgs" ON public.tax_groups
  FOR ALL USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

-- Tax group items inherit from parent group
CREATE POLICY "Users can view tax group items" ON public.tax_group_items
  FOR SELECT USING (tax_group_id IN (
    SELECT id FROM public.tax_groups WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
  ));

CREATE POLICY "Users can manage tax group items" ON public.tax_group_items
  FOR ALL USING (tax_group_id IN (
    SELECT id FROM public.tax_groups WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
  ));

-- Create updated_at trigger for tax_rates
CREATE TRIGGER update_tax_rates_updated_at
  BEFORE UPDATE ON public.tax_rates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
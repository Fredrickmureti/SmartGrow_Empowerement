-- Platform Bank Providers table for admin-configured bank integrations
CREATE TABLE public.platform_bank_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_code TEXT NOT NULL UNIQUE, -- 'jenga', 'kcb_buni', 'coop_connect', 'mono', 'manual'
  provider_name TEXT NOT NULL,
  description TEXT,
  logo_url TEXT,
  api_base_url TEXT,
  api_key_encrypted TEXT,
  api_secret_encrypted TEXT,
  merchant_code TEXT, -- For Jenga
  public_key TEXT, -- For Jenga signature verification
  private_key_encrypted TEXT, -- For Jenga request signing
  is_enabled BOOLEAN DEFAULT false,
  is_sandbox BOOLEAN DEFAULT true,
  supported_countries TEXT[] DEFAULT ARRAY['KE'],
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS on platform_bank_providers
ALTER TABLE public.platform_bank_providers ENABLE ROW LEVEL SECURITY;

-- Only platform admins can manage bank providers
CREATE POLICY "Platform admins can manage bank providers"
  ON public.platform_bank_providers
  FOR ALL
  USING (public.is_platform_admin(auth.uid()));

-- Bank transactions table for storing synced transactions
CREATE TABLE public.bank_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  bank_account_id UUID NOT NULL REFERENCES public.bank_accounts(id) ON DELETE CASCADE,
  external_transaction_id TEXT NOT NULL,
  transaction_date DATE NOT NULL,
  posting_date DATE,
  description TEXT NOT NULL,
  reference TEXT,
  amount NUMERIC(15,2) NOT NULL,
  balance_after NUMERIC(15,2),
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('credit', 'debit')),
  category TEXT,
  category_confidence NUMERIC(3,2) CHECK (category_confidence >= 0 AND category_confidence <= 1),
  is_reconciled BOOLEAN DEFAULT false,
  reconciled_type TEXT CHECK (reconciled_type IN ('invoice', 'expense', 'bill', 'transfer', 'manual')),
  reconciled_entity_id UUID,
  reconciled_at TIMESTAMPTZ,
  reconciled_by UUID,
  raw_data JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(bank_account_id, external_transaction_id)
);

-- Enable RLS on bank_transactions
ALTER TABLE public.bank_transactions ENABLE ROW LEVEL SECURITY;

-- Organization members can view their bank transactions
CREATE POLICY "Organization members can view bank transactions"
  ON public.bank_transactions
  FOR SELECT
  USING (public.is_org_member(auth.uid(), organization_id));

-- Organization members can insert bank transactions
CREATE POLICY "Organization members can insert bank transactions"
  ON public.bank_transactions
  FOR INSERT
  WITH CHECK (public.is_org_member(auth.uid(), organization_id));

-- Organization members can update bank transactions
CREATE POLICY "Organization members can update bank transactions"
  ON public.bank_transactions
  FOR UPDATE
  USING (public.is_org_member(auth.uid(), organization_id));

-- Transaction categorization rules table
CREATE TABLE public.transaction_categorization_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  rule_name TEXT NOT NULL,
  description_pattern TEXT, -- Regex pattern to match
  reference_pattern TEXT,
  min_amount NUMERIC(15,2),
  max_amount NUMERIC(15,2),
  transaction_type TEXT CHECK (transaction_type IN ('credit', 'debit', 'both')),
  target_category TEXT NOT NULL,
  target_account_id UUID REFERENCES public.accounts(id),
  priority INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS on transaction_categorization_rules
ALTER TABLE public.transaction_categorization_rules ENABLE ROW LEVEL SECURITY;

-- Organization members can manage their categorization rules
CREATE POLICY "Organization members can manage categorization rules"
  ON public.transaction_categorization_rules
  FOR ALL
  USING (public.is_org_member(auth.uid(), organization_id));

-- Add new columns to bank_accounts table
ALTER TABLE public.bank_accounts 
  ADD COLUMN IF NOT EXISTS provider_id UUID REFERENCES public.platform_bank_providers(id),
  ADD COLUMN IF NOT EXISTS external_account_id TEXT,
  ADD COLUMN IF NOT EXISTS access_token_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS refresh_token_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sync_status TEXT DEFAULT 'pending' CHECK (sync_status IN ('pending', 'syncing', 'synced', 'error')),
  ADD COLUMN IF NOT EXISTS sync_error TEXT,
  ADD COLUMN IF NOT EXISTS sync_from_date DATE;

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_bank_transactions_org_id ON public.bank_transactions(organization_id);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_bank_account_id ON public.bank_transactions(bank_account_id);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_date ON public.bank_transactions(transaction_date);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_reconciled ON public.bank_transactions(is_reconciled);
CREATE INDEX IF NOT EXISTS idx_categorization_rules_org_id ON public.transaction_categorization_rules(organization_id);

-- Add trigger for updated_at on platform_bank_providers
CREATE TRIGGER update_platform_bank_providers_updated_at
  BEFORE UPDATE ON public.platform_bank_providers
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Add trigger for updated_at on bank_transactions
CREATE TRIGGER update_bank_transactions_updated_at
  BEFORE UPDATE ON public.bank_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Add trigger for updated_at on transaction_categorization_rules
CREATE TRIGGER update_transaction_categorization_rules_updated_at
  BEFORE UPDATE ON public.transaction_categorization_rules
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Insert default bank providers (admin will configure credentials)
INSERT INTO public.platform_bank_providers (provider_code, provider_name, description, api_base_url, supported_countries)
VALUES 
  ('jenga', 'Jenga API (Equity Bank)', 'Equity Bank Kenya integration via Jenga API for account balance, statements, and payments', 'https://api.jengaapi.io', ARRAY['KE']),
  ('kcb_buni', 'KCB BUNI', 'Kenya Commercial Bank integration for business banking', 'https://uat.buni.kcbbankgroup.com', ARRAY['KE']),
  ('coop_connect', 'Co-op Connect', 'Co-operative Bank of Kenya API integration', 'https://developer.co-opbank.co.ke', ARRAY['KE']),
  ('manual', 'Manual Import', 'Import bank statements manually via CSV upload', NULL, ARRAY['KE', 'US', 'GB', 'EU'])
ON CONFLICT (provider_code) DO NOTHING;
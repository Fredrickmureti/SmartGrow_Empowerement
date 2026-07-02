
-- ============================================================
-- Phase 1D: Create tax_account_mappings table
-- ============================================================

CREATE TABLE IF NOT EXISTS public.tax_account_mappings (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  tax_rate_id uuid NOT NULL REFERENCES public.tax_rates(id) ON DELETE CASCADE,
  account_type text NOT NULL CHECK (account_type IN ('sales_tax', 'purchase_tax', 'tax_payable', 'tax_receivable')),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tax_rate_id, account_type)
);

ALTER TABLE public.tax_account_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view tax account mappings in their orgs"
  ON public.tax_account_mappings FOR SELECT
  USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can manage tax account mappings in their orgs"
  ON public.tax_account_mappings FOR ALL
  USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

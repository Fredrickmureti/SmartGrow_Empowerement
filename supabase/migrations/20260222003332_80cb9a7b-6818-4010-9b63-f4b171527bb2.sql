
-- ============================================================
-- Fix 1: Configurable GL Account Mappings
-- ============================================================
CREATE TABLE IF NOT EXISTS public.default_account_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  setting_key text NOT NULL,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_default_account_setting UNIQUE(organization_id, business_id, setting_key)
);

ALTER TABLE public.default_account_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view default account settings for their org"
  ON public.default_account_settings FOR SELECT
  USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
  ));

CREATE POLICY "Users can manage default account settings for their org"
  ON public.default_account_settings FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
  ))
  WITH CHECK (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
  ));

-- Trigger for updated_at
CREATE TRIGGER update_default_account_settings_updated_at
  BEFORE UPDATE ON public.default_account_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- Fix 2: Duplicate Posting Protection (Idempotency Index)
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_source_unique
  ON public.journal_entries(organization_id, source_type, source_id)
  WHERE source_type IS NOT NULL AND source_id IS NOT NULL AND status != 'voided';

-- ============================================================
-- Fix 3: Server-side Report Aggregation RPC
-- ============================================================

-- Function: aggregate account movements for a date range
CREATE OR REPLACE FUNCTION public.get_account_movements(
  _org_id uuid,
  _date_from date DEFAULT '1900-01-01',
  _date_to date DEFAULT '2099-12-31'
)
RETURNS TABLE(account_id uuid, total_debit numeric, total_credit numeric)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jel.account_id,
         COALESCE(SUM(jel.debit), 0) AS total_debit,
         COALESCE(SUM(jel.credit), 0) AS total_credit
  FROM journal_entry_lines jel
  JOIN journal_entries je ON je.id = jel.journal_entry_id
  WHERE je.organization_id = _org_id
    AND je.status = 'posted'
    AND je.entry_date >= _date_from
    AND je.entry_date <= _date_to
  GROUP BY jel.account_id;
$$;

-- Function: get detailed GL transactions for specific accounts in a date range
CREATE OR REPLACE FUNCTION public.get_gl_transactions(
  _org_id uuid,
  _date_from date,
  _date_to date,
  _account_ids uuid[] DEFAULT NULL
)
RETURNS TABLE(
  line_id uuid,
  account_id uuid,
  debit numeric,
  credit numeric,
  line_description text,
  entry_id uuid,
  entry_date date,
  entry_number text,
  entry_description text,
  reference text,
  source_type text,
  source_id uuid,
  contact_name text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    jel.id AS line_id,
    jel.account_id,
    COALESCE(jel.debit, 0) AS debit,
    COALESCE(jel.credit, 0) AS credit,
    jel.description AS line_description,
    je.id AS entry_id,
    je.entry_date,
    je.entry_number,
    je.description AS entry_description,
    je.reference,
    je.source_type,
    je.source_id,
    c.name AS contact_name
  FROM journal_entry_lines jel
  JOIN journal_entries je ON je.id = jel.journal_entry_id
  LEFT JOIN contacts c ON c.id = jel.contact_id
  WHERE je.organization_id = _org_id
    AND je.status = 'posted'
    AND je.entry_date >= _date_from
    AND je.entry_date <= _date_to
    AND (_account_ids IS NULL OR jel.account_id = ANY(_account_ids))
  ORDER BY je.entry_date, je.entry_number;
$$;

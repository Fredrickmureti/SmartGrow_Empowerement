
-- 1. check_balance_integrity: scope by business
DROP FUNCTION IF EXISTS public.check_balance_integrity(uuid);

CREATE OR REPLACE FUNCTION public.check_balance_integrity(
  _org_id uuid,
  _business_id uuid DEFAULT NULL
)
RETURNS TABLE(
  account_id uuid,
  business_id uuid,
  account_code text,
  account_name text,
  stored_balance numeric,
  ledger_balance numeric,
  drift numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH ledger AS (
    SELECT jel.account_id,
      je.business_id,
      SUM(CASE WHEN acct.account_type IN ('asset','expense')
        THEN COALESCE(jel.debit,0) - COALESCE(jel.credit,0)
        ELSE COALESCE(jel.credit,0) - COALESCE(jel.debit,0)
      END) AS balance
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    JOIN accounts acct ON acct.id = jel.account_id
    WHERE je.organization_id = _org_id
      AND je.status = 'posted'
      AND (_business_id IS NULL OR je.business_id = _business_id)
    GROUP BY jel.account_id, je.business_id
  )
  SELECT a.id AS account_id,
         a.business_id,
         a.code AS account_code,
         a.name AS account_name,
         COALESCE(a.current_balance, 0) AS stored_balance,
         COALESCE(l.balance, 0) AS ledger_balance,
         COALESCE(a.current_balance, 0) - COALESCE(l.balance, 0) AS drift
  FROM accounts a
  LEFT JOIN ledger l
    ON l.account_id = a.id
   AND l.business_id = a.business_id
  WHERE a.organization_id = _org_id
    AND (_business_id IS NULL OR a.business_id = _business_id)
    AND ABS(COALESCE(a.current_balance, 0) - COALESCE(l.balance, 0)) > 0.001;
$$;

-- 2. accounting_integrity_reports: add business_id
ALTER TABLE public.accounting_integrity_reports
  ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_integrity_reports_org_biz_ran
  ON public.accounting_integrity_reports (organization_id, business_id, ran_at DESC);

-- 3. invoices / bills: business_id NOT NULL + per-business number uniqueness
ALTER TABLE public.invoices ALTER COLUMN business_id SET NOT NULL;
ALTER TABLE public.bills    ALTER COLUMN business_id SET NOT NULL;

ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_organization_id_invoice_number_key;
DROP INDEX IF EXISTS public.invoices_organization_id_invoice_number_key;
DROP INDEX IF EXISTS public.idx_invoices_org_number;

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_business_number
  ON public.invoices (business_id, invoice_number);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bills_business_number
  ON public.bills (business_id, bill_number);

-- 4. Drop dual-stacked permissive RLS on invoices/bills
-- Keep ONLY the granular module-permission policies (*_perm).
DROP POLICY IF EXISTS "Admins can delete all bills" ON public.bills;
DROP POLICY IF EXISTS "Users can create bills in their orgs" ON public.bills;
DROP POLICY IF EXISTS "Users can delete draft bills" ON public.bills;
DROP POLICY IF EXISTS "Users can update bills in their orgs" ON public.bills;
DROP POLICY IF EXISTS "Users can view bills in their orgs" ON public.bills;

DROP POLICY IF EXISTS "Admins can delete all invoices" ON public.invoices;
DROP POLICY IF EXISTS "Users can delete draft invoices" ON public.invoices;
-- Keep platform_admin policies (super-admin escape hatch) and subscription gates.


-- Priority 3: Lightweight RPC to derive account balances from posted JE lines
CREATE OR REPLACE FUNCTION public.get_account_balances(
  _org_id UUID,
  _business_id UUID DEFAULT NULL
)
RETURNS TABLE (
  account_id UUID,
  je_balance NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jel.account_id,
    SUM(CASE WHEN acct.account_type IN ('asset','expense')
      THEN COALESCE(jel.debit,0) - COALESCE(jel.credit,0)
      ELSE COALESCE(jel.credit,0) - COALESCE(jel.debit,0)
    END) AS je_balance
  FROM journal_entry_lines jel
  JOIN journal_entries je ON je.id = jel.journal_entry_id
  JOIN accounts acct ON acct.id = jel.account_id
  WHERE je.organization_id = _org_id
    AND je.status = 'posted'
    AND (_business_id IS NULL OR je.business_id = _business_id)
  GROUP BY jel.account_id;
$$;

-- Priority 5: Balance integrity drift check
CREATE OR REPLACE FUNCTION public.check_balance_integrity(
  _org_id UUID
)
RETURNS TABLE (
  account_id UUID,
  account_code TEXT,
  account_name TEXT,
  stored_balance NUMERIC,
  ledger_balance NUMERIC,
  drift NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ledger AS (
    SELECT jel.account_id,
      SUM(CASE WHEN acct.account_type IN ('asset','expense')
        THEN COALESCE(jel.debit,0) - COALESCE(jel.credit,0)
        ELSE COALESCE(jel.credit,0) - COALESCE(jel.debit,0)
      END) AS balance
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    JOIN accounts acct ON acct.id = jel.account_id
    WHERE je.organization_id = _org_id
      AND je.status = 'posted'
    GROUP BY jel.account_id
  )
  SELECT a.id AS account_id,
         a.code AS account_code,
         a.name AS account_name,
         COALESCE(a.current_balance, 0) AS stored_balance,
         COALESCE(l.balance, 0) AS ledger_balance,
         COALESCE(a.current_balance, 0) - COALESCE(l.balance, 0) AS drift
  FROM accounts a
  LEFT JOIN ledger l ON l.account_id = a.id
  WHERE a.organization_id = _org_id
    AND ABS(COALESCE(a.current_balance, 0) - COALESCE(l.balance, 0)) > 0.001;
$$;

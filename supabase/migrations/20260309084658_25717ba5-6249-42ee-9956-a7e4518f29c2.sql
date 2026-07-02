
-- Phase 1: Fix the get_account_movements RPC
-- Drop the 3-arg overload first
DROP FUNCTION IF EXISTS public.get_account_movements(uuid, date, date);

-- Replace the 4-arg version: remove the broken a.business_id filter
-- The JE's business_id is the correct filter, not the account's business_id
CREATE OR REPLACE FUNCTION public.get_account_movements(
  _org_id uuid, _date_from date, _date_to date, _business_id uuid DEFAULT NULL
)
RETURNS TABLE(account_id uuid, total_debit numeric, total_credit numeric)
LANGUAGE sql STABLE SECURITY DEFINER
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
    AND (_business_id IS NULL OR je.business_id = _business_id)
  GROUP BY jel.account_id;
$$;

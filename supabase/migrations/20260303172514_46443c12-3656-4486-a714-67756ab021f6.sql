
-- Fix 1: Update get_account_movements RPC to accept optional _business_id parameter
CREATE OR REPLACE FUNCTION public.get_account_movements(
  _org_id uuid,
  _date_from date DEFAULT '1900-01-01'::date,
  _date_to date DEFAULT '2099-12-31'::date,
  _business_id uuid DEFAULT NULL
)
RETURNS TABLE(account_id uuid, total_debit numeric, total_credit numeric)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jel.account_id,
         COALESCE(SUM(jel.debit), 0),
         COALESCE(SUM(jel.credit), 0)
  FROM journal_entry_lines jel
  JOIN journal_entries je ON je.id = jel.journal_entry_id
  WHERE je.organization_id = _org_id
    AND je.status = 'posted'
    AND je.entry_date >= _date_from
    AND je.entry_date <= _date_to
    AND (_business_id IS NULL OR je.business_id = _business_id)
  GROUP BY jel.account_id;
$$;


-- Must drop first because return type changed (source_id text -> uuid)
DROP FUNCTION IF EXISTS public.get_general_ledger(uuid, date, date, uuid, uuid[], boolean);

-- Recreate with corrected return type
CREATE OR REPLACE FUNCTION public.get_general_ledger(
  _org_id uuid,
  _date_from date,
  _date_to date,
  _business_id uuid DEFAULT NULL,
  _account_ids uuid[] DEFAULT NULL,
  _include_zero_activity boolean DEFAULT false
)
RETURNS TABLE(
  account_id uuid,
  account_code text,
  account_name text,
  account_type text,
  opening_balance numeric,
  line_id uuid,
  entry_date date,
  entry_number text,
  je_description text,
  line_description text,
  reference text,
  debit numeric,
  credit numeric,
  source_type text,
  source_id uuid,
  contact_name text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH filtered_accounts AS (
    SELECT a.id, a.code, a.name, a.account_type::TEXT AS atype, COALESCE(a.opening_balance, 0) AS ob
    FROM accounts a
    WHERE a.organization_id = _org_id
      AND a.is_active = TRUE
      AND (_business_id IS NULL OR a.business_id = _business_id OR a.business_id IS NULL)
      AND (_account_ids IS NULL OR a.id = ANY(_account_ids))
  ),
  prior_movements AS (
    SELECT
      jel.account_id AS acc_id,
      COALESCE(SUM(jel.debit), 0) AS prior_debit,
      COALESCE(SUM(jel.credit), 0) AS prior_credit
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.organization_id = _org_id
      AND je.status = 'posted'
      AND je.entry_date < _date_from
    GROUP BY jel.account_id
  ),
  period_lines AS (
    SELECT
      jel.account_id AS acc_id,
      jel.id AS lid,
      je.entry_date AS edate,
      je.entry_number AS enum,
      je.description AS jdesc,
      jel.description AS ldesc,
      je.reference AS ref,
      jel.debit AS d,
      jel.credit AS c,
      je.source_type AS stype,
      je.source_id AS sid,
      ct.name AS cname
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    LEFT JOIN contacts ct ON ct.id = jel.contact_id
    WHERE je.organization_id = _org_id
      AND je.status = 'posted'
      AND je.entry_date >= _date_from
      AND je.entry_date <= _date_to
  ),
  accounts_with_activity AS (
    SELECT DISTINCT acc_id FROM period_lines
  )
  SELECT
    fa.id,
    fa.code,
    fa.name,
    fa.atype,
    CASE
      WHEN fa.atype IN ('asset', 'expense') THEN fa.ob + COALESCE(pm.prior_debit, 0) - COALESCE(pm.prior_credit, 0)
      ELSE fa.ob + COALESCE(pm.prior_credit, 0) - COALESCE(pm.prior_debit, 0)
    END,
    pl.lid,
    pl.edate,
    pl.enum,
    pl.jdesc,
    pl.ldesc,
    pl.ref,
    pl.d,
    pl.c,
    pl.stype,
    pl.sid,
    pl.cname
  FROM filtered_accounts fa
  LEFT JOIN prior_movements pm ON pm.acc_id = fa.id
  LEFT JOIN period_lines pl ON pl.acc_id = fa.id
  WHERE _include_zero_activity = TRUE
     OR EXISTS (SELECT 1 FROM accounts_with_activity awa WHERE awa.acc_id = fa.id)
  ORDER BY fa.code, pl.edate, pl.lid;
END;
$$;

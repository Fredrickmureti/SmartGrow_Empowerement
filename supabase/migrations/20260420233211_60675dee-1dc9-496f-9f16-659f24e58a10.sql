-- Wave 4: harden financial RPCs (corrected — preserves existing return signature)

CREATE INDEX IF NOT EXISTS idx_jel_account_entry
  ON public.journal_entry_lines (account_id, journal_entry_id);

-- get_account_movements: validate business belongs to org
CREATE OR REPLACE FUNCTION public.get_account_movements(
  _org_id uuid,
  _date_from date,
  _date_to date,
  _business_id uuid DEFAULT NULL
)
RETURNS TABLE (
  account_id uuid,
  total_debit numeric,
  total_credit numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'get_account_movements: _org_id is required';
  END IF;

  IF _business_id IS NOT NULL THEN
    PERFORM 1
      FROM public.businesses b
      WHERE b.id = _business_id AND b.organization_id = _org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'get_account_movements: business % does not belong to org %', _business_id, _org_id;
    END IF;
  END IF;

  RETURN QUERY
  SELECT
    jel.account_id,
    COALESCE(SUM(jel.debit), 0)::numeric  AS total_debit,
    COALESCE(SUM(jel.credit), 0)::numeric AS total_credit
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE je.organization_id = _org_id
    AND je.status = 'posted'
    AND je.entry_date BETWEEN _date_from AND _date_to
    AND (_business_id IS NULL OR je.business_id = _business_id)
  GROUP BY jel.account_id;
END;
$$;

-- get_general_ledger: drop + recreate preserving original return signature exactly
DROP FUNCTION IF EXISTS public.get_general_ledger(uuid, date, date, uuid, uuid[], boolean);

CREATE FUNCTION public.get_general_ledger(
  _org_id uuid,
  _date_from date,
  _date_to date,
  _business_id uuid DEFAULT NULL,
  _account_ids uuid[] DEFAULT NULL,
  _include_zero_activity boolean DEFAULT false
)
RETURNS TABLE (
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
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'get_general_ledger: _org_id is required';
  END IF;

  IF _business_id IS NOT NULL THEN
    PERFORM 1
      FROM public.businesses b
      WHERE b.id = _business_id AND b.organization_id = _org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'get_general_ledger: business % does not belong to org %', _business_id, _org_id;
    END IF;
  END IF;

  RETURN QUERY
  WITH scope AS (
    SELECT a.id, a.code, a.name, a.account_type::text AS account_type,
           COALESCE(a.opening_balance, 0) AS opening_balance
    FROM public.accounts a
    WHERE a.organization_id = _org_id
      AND a.is_active = true
      AND (_business_id IS NULL OR a.business_id = _business_id OR a.business_id IS NULL)
      AND (_account_ids IS NULL OR a.id = ANY(_account_ids))
  ),
  prior AS (
    SELECT jel.account_id,
           COALESCE(SUM(jel.debit - jel.credit), 0) AS prior_net
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.organization_id = _org_id
      AND je.status = 'posted'
      AND je.entry_date < _date_from
      AND (_business_id IS NULL OR je.business_id = _business_id)
    GROUP BY jel.account_id
  ),
  period_lines AS (
    SELECT
      jel.account_id,
      jel.id           AS line_id,
      je.entry_date,
      je.entry_number,
      je.description   AS je_description,
      jel.description  AS line_description,
      je.reference,
      COALESCE(jel.debit, 0)  AS debit,
      COALESCE(jel.credit, 0) AS credit,
      je.source_type,
      je.source_id,
      c.name           AS contact_name
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    LEFT JOIN public.contacts c ON c.id = jel.contact_id
    WHERE je.organization_id = _org_id
      AND je.status = 'posted'
      AND je.entry_date BETWEEN _date_from AND _date_to
      AND (_business_id IS NULL OR je.business_id = _business_id)
  )
  SELECT
    s.id           AS account_id,
    s.code         AS account_code,
    s.name         AS account_name,
    s.account_type,
    (s.opening_balance + COALESCE(p.prior_net, 0)) AS opening_balance,
    pl.line_id,
    pl.entry_date,
    pl.entry_number,
    pl.je_description,
    pl.line_description,
    pl.reference,
    pl.debit,
    pl.credit,
    pl.source_type,
    pl.source_id,
    pl.contact_name
  FROM scope s
  LEFT JOIN prior p     ON p.account_id  = s.id
  LEFT JOIN period_lines pl ON pl.account_id = s.id
  WHERE _include_zero_activity
     OR pl.line_id IS NOT NULL
     OR (s.opening_balance + COALESCE(p.prior_net, 0)) <> 0
  ORDER BY s.code, pl.entry_date NULLS FIRST, pl.entry_number NULLS FIRST, pl.line_id NULLS FIRST;
END;
$$;
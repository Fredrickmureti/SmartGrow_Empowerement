
-- ============================================================
-- P1: ATOMIC GL TRANSACTIONS + MULTI-CURRENCY + GL LEDGER RPC
-- ============================================================

-- 1. Atomic GL posting RPC (header + lines in single transaction)
CREATE OR REPLACE FUNCTION public.post_journal_entry_atomic(
  _org_id UUID,
  _business_id UUID,
  _entry_number TEXT,
  _entry_date DATE,
  _reference TEXT,
  _description TEXT,
  _source_type TEXT,
  _source_id TEXT,
  _created_by UUID,
  _is_closing BOOLEAN DEFAULT FALSE,
  _is_adjusting BOOLEAN DEFAULT FALSE,
  _lines JSONB DEFAULT '[]'::JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _je_id UUID;
  _total_debit NUMERIC := 0;
  _total_credit NUMERIC := 0;
  _line JSONB;
  _sort INT := 0;
BEGIN
  -- Validate lines array is not empty
  IF jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'Journal entry must have at least one line';
  END IF;

  -- Validate debits = credits
  SELECT
    COALESCE(SUM((l->>'debit')::NUMERIC), 0),
    COALESCE(SUM((l->>'credit')::NUMERIC), 0)
  INTO _total_debit, _total_credit
  FROM jsonb_array_elements(_lines) AS l;

  IF ABS(_total_debit - _total_credit) > 0.001 THEN
    RAISE EXCEPTION 'Debits (%) must equal Credits (%)', _total_debit, _total_credit;
  END IF;

  -- Insert journal entry header
  INSERT INTO journal_entries (
    organization_id, business_id, entry_number, entry_date,
    reference, description, source_type, source_id,
    status, is_closing, is_adjusting,
    created_by, posted_at, posted_by
  ) VALUES (
    _org_id, _business_id, _entry_number, _entry_date,
    _reference, _description, _source_type, _source_id,
    'posted', _is_closing, _is_adjusting,
    _created_by, NOW(), _created_by
  )
  RETURNING id INTO _je_id;

  -- Insert all lines
  FOR _line IN SELECT * FROM jsonb_array_elements(_lines)
  LOOP
    _sort := _sort + 1;
    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, debit, credit,
      description, contact_id, sort_order
    ) VALUES (
      _je_id,
      (_line->>'account_id')::UUID,
      COALESCE((_line->>'debit')::NUMERIC, 0),
      COALESCE((_line->>'credit')::NUMERIC, 0),
      _line->>'description',
      CASE WHEN _line->>'contact_id' IS NOT NULL THEN (_line->>'contact_id')::UUID ELSE NULL END,
      _sort
    );
  END LOOP;

  RETURN _je_id;
END;
$$;

-- 2. Multi-currency columns on journal_entry_lines
ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS original_currency TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS original_debit NUMERIC DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS original_credit NUMERIC DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC DEFAULT NULL;

-- 3. Multi-currency columns on journal_entries (store document currency)
ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC DEFAULT NULL;

-- 4. General Ledger RPC to avoid 1000-row limit
CREATE OR REPLACE FUNCTION public.get_general_ledger(
  _org_id UUID,
  _date_from DATE,
  _date_to DATE,
  _business_id UUID DEFAULT NULL,
  _account_ids UUID[] DEFAULT NULL,
  _include_zero_activity BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  account_id UUID,
  account_code TEXT,
  account_name TEXT,
  account_type TEXT,
  opening_balance NUMERIC,
  -- Transaction fields
  line_id UUID,
  entry_date DATE,
  entry_number TEXT,
  je_description TEXT,
  line_description TEXT,
  reference TEXT,
  debit NUMERIC,
  credit NUMERIC,
  source_type TEXT,
  source_id TEXT,
  contact_name TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
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
  -- Return account header rows (line_id IS NULL) followed by transaction rows
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

-- 5. Bank reconciliation GL posting support: add journal_entry_id to bank_transactions
ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS journal_entry_id UUID REFERENCES public.journal_entries(id) DEFAULT NULL;

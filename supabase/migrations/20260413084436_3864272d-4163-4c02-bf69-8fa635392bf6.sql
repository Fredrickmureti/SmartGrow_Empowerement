
-- ============================================================
-- 1. Update post_journal_entry_atomic to support currency,
--    exchange_rate, and analytic_account_id on lines
-- ============================================================
CREATE OR REPLACE FUNCTION public.post_journal_entry_atomic(
  _org_id uuid,
  _business_id uuid DEFAULT NULL,
  _entry_number text DEFAULT '',
  _entry_date date DEFAULT CURRENT_DATE,
  _reference text DEFAULT '',
  _description text DEFAULT '',
  _source_type text DEFAULT 'manual',
  _source_id text DEFAULT '',
  _created_by uuid DEFAULT NULL,
  _is_closing boolean DEFAULT false,
  _is_adjusting boolean DEFAULT false,
  _lines jsonb DEFAULT '[]'::jsonb,
  _currency text DEFAULT NULL,
  _exchange_rate numeric DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _je_id uuid;
  _line jsonb;
  _total_debit numeric := 0;
  _total_credit numeric := 0;
BEGIN
  -- Validate lines balance
  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    _total_debit := _total_debit + COALESCE((_line->>'debit')::numeric, 0);
    _total_credit := _total_credit + COALESCE((_line->>'credit')::numeric, 0);
  END LOOP;

  IF abs(_total_debit - _total_credit) > 0.001 THEN
    RAISE EXCEPTION 'Journal entry is not balanced: debits=% credits=%', _total_debit, _total_credit;
  END IF;

  -- Insert header
  INSERT INTO journal_entries (
    organization_id, business_id, entry_number, entry_date,
    reference, description, source_type, source_id,
    created_by, status, is_closing, is_adjusting,
    currency, exchange_rate, posted_at
  ) VALUES (
    _org_id, _business_id, _entry_number, _entry_date,
    _reference, _description, _source_type, _source_id,
    _created_by, 'posted', _is_closing, _is_adjusting,
    _currency, _exchange_rate, now()
  )
  RETURNING id INTO _je_id;

  -- Insert lines
  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    INSERT INTO journal_entry_lines (
      journal_entry_id,
      account_id,
      debit,
      credit,
      description,
      contact_id,
      analytic_account_id,
      exchange_rate
    ) VALUES (
      _je_id,
      (_line->>'account_id')::uuid,
      COALESCE((_line->>'debit')::numeric, 0),
      COALESCE((_line->>'credit')::numeric, 0),
      COALESCE(_line->>'description', ''),
      CASE WHEN _line->>'contact_id' IS NOT NULL AND _line->>'contact_id' != ''
           THEN (_line->>'contact_id')::uuid ELSE NULL END,
      CASE WHEN _line->>'analytic_account_id' IS NOT NULL AND _line->>'analytic_account_id' != ''
           THEN (_line->>'analytic_account_id')::uuid ELSE NULL END,
      CASE WHEN _line->>'exchange_rate' IS NOT NULL
           THEN (_line->>'exchange_rate')::numeric ELSE _exchange_rate END
    );
  END LOOP;

  RETURN _je_id::text;
END;
$$;

-- ============================================================
-- 2. Budget enforcement check function
-- ============================================================
CREATE OR REPLACE FUNCTION public.check_budget_variance(
  _org_id uuid,
  _account_ids uuid[],
  _amounts numeric[],
  _entry_date date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _fiscal_year int;
  _month int;
  _result jsonb := '[]'::jsonb;
  _i int;
  _account_id uuid;
  _amount numeric;
  _budget_amount numeric;
  _actual_amount numeric;
  _budget_name text;
  _account_name text;
BEGIN
  _fiscal_year := EXTRACT(YEAR FROM _entry_date)::int;
  _month := EXTRACT(MONTH FROM _entry_date)::int;

  FOR _i IN 1..array_length(_account_ids, 1) LOOP
    _account_id := _account_ids[_i];
    _amount := _amounts[_i];

    -- Find budget item for this account + month + year
    SELECT bi.budgeted_amount, b.name, a.name
    INTO _budget_amount, _budget_name, _account_name
    FROM budget_items bi
    JOIN budgets b ON b.id = bi.budget_id
    JOIN accounts a ON a.id = bi.account_id
    WHERE bi.account_id = _account_id
      AND bi.period_month = _month
      AND b.fiscal_year = _fiscal_year
      AND b.organization_id = _org_id
      AND b.status = 'active'
    LIMIT 1;

    IF _budget_amount IS NOT NULL THEN
      -- Get current actual for this account+month
      SELECT COALESCE(SUM(
        CASE WHEN a2.account_type IN ('asset','expense') THEN jel.debit - jel.credit
             ELSE jel.credit - jel.debit END
      ), 0)
      INTO _actual_amount
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      JOIN accounts a2 ON a2.id = jel.account_id
      WHERE jel.account_id = _account_id
        AND je.organization_id = _org_id
        AND je.status = 'posted'
        AND EXTRACT(YEAR FROM je.entry_date) = _fiscal_year
        AND EXTRACT(MONTH FROM je.entry_date) = _month;

      -- Check if posting this amount would exceed budget
      IF (_actual_amount + _amount) > _budget_amount * 1.0 THEN
        _result := _result || jsonb_build_object(
          'account_id', _account_id,
          'account_name', _account_name,
          'budget_name', _budget_name,
          'budgeted', _budget_amount,
          'actual_before', _actual_amount,
          'posting_amount', _amount,
          'projected_total', _actual_amount + _amount,
          'exceeded', true
        );
      END IF;
    END IF;
  END LOOP;

  RETURN _result;
END;
$$;

-- ============================================================
-- 3. Bank reconciliation match suggestions function
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_reconciliation_match_suggestions(
  _org_id uuid,
  _bank_account_id uuid,
  _limit int DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _bank_gl_account_id uuid;
  _result jsonb := '[]'::jsonb;
  _txn record;
  _match record;
BEGIN
  -- Get the GL account linked to this bank account
  SELECT account_id INTO _bank_gl_account_id
  FROM bank_accounts
  WHERE id = _bank_account_id AND organization_id = _org_id;

  IF _bank_gl_account_id IS NULL THEN
    RETURN _result;
  END IF;

  -- For each unreconciled bank transaction, find potential GL matches
  FOR _txn IN
    SELECT bt.id, bt.amount, bt.transaction_date, bt.description,
           bt.reference, bt.transaction_type
    FROM bank_transactions bt
    WHERE bt.bank_account_id = _bank_account_id
      AND bt.organization_id = _org_id
      AND bt.is_reconciled = false
    ORDER BY bt.transaction_date DESC
    LIMIT _limit
  LOOP
    -- Find JE lines on the bank GL account with matching amount and close date
    FOR _match IN
      SELECT
        jel.id AS line_id,
        je.id AS journal_entry_id,
        je.entry_number,
        je.entry_date,
        je.description AS je_description,
        je.source_type,
        je.source_id,
        jel.debit,
        jel.credit,
        -- Score: exact amount + date proximity
        CASE
          WHEN ABS(
            CASE WHEN _txn.transaction_type = 'credit' THEN jel.debit ELSE jel.credit END
            - ABS(_txn.amount)
          ) < 0.01 THEN 50
          ELSE 0
        END +
        CASE
          WHEN ABS(je.entry_date - _txn.transaction_date) = 0 THEN 30
          WHEN ABS(je.entry_date - _txn.transaction_date) <= 3 THEN 20
          WHEN ABS(je.entry_date - _txn.transaction_date) <= 7 THEN 10
          ELSE 0
        END +
        CASE
          WHEN _txn.reference IS NOT NULL AND _txn.reference != ''
               AND je.reference ILIKE '%' || _txn.reference || '%' THEN 20
          ELSE 0
        END AS match_score
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE jel.account_id = _bank_gl_account_id
        AND je.organization_id = _org_id
        AND je.status = 'posted'
        -- Amount direction check
        AND (
          (_txn.transaction_type = 'credit' AND jel.debit > 0)
          OR (_txn.transaction_type = 'debit' AND jel.credit > 0)
        )
        -- Amount within 1% tolerance
        AND ABS(
          CASE WHEN _txn.transaction_type = 'credit' THEN jel.debit ELSE jel.credit END
          - ABS(_txn.amount)
        ) < ABS(_txn.amount) * 0.01 + 0.01
        -- Date within 30 days
        AND ABS(je.entry_date - _txn.transaction_date) <= 30
        -- Not already matched to another reconciled transaction
        AND NOT EXISTS (
          SELECT 1 FROM bank_transactions bt2
          WHERE bt2.matched_journal_entry_id = je.id
            AND bt2.is_reconciled = true
        )
      ORDER BY match_score DESC
      LIMIT 3
    LOOP
      IF _match.match_score >= 50 THEN
        _result := _result || jsonb_build_object(
          'bank_transaction_id', _txn.id,
          'bank_amount', _txn.amount,
          'bank_date', _txn.transaction_date,
          'bank_description', _txn.description,
          'journal_entry_id', _match.journal_entry_id,
          'entry_number', _match.entry_number,
          'entry_date', _match.entry_date,
          'je_description', _match.je_description,
          'source_type', _match.source_type,
          'source_id', _match.source_id,
          'gl_amount', CASE WHEN _txn.transaction_type = 'credit' THEN _match.debit ELSE _match.credit END,
          'match_score', _match.match_score,
          'line_id', _match.line_id
        );
      END IF;
    END LOOP;
  END LOOP;

  RETURN _result;
END;
$$;

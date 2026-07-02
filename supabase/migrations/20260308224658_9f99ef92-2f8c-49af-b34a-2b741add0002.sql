
-- RPC: Migrate account opening_balance values into a proper Opening Balance journal entry,
-- then zero out the opening_balance fields to prevent double-counting.
-- Returns the created journal_entry id.
CREATE OR REPLACE FUNCTION public.migrate_opening_balances_to_je(
  _org_id uuid,
  _business_id uuid DEFAULT NULL,
  _entry_date date DEFAULT '2024-01-01'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _je_id uuid;
  _entry_number text;
  _acct record;
  _debit numeric;
  _credit numeric;
  _total_debit numeric := 0;
  _total_credit numeric := 0;
  _line_order int := 0;
BEGIN
  -- Check if there are any non-zero opening balances to migrate
  IF NOT EXISTS (
    SELECT 1 FROM accounts
    WHERE organization_id = _org_id
      AND is_active = true
      AND opening_balance != 0
      AND (_business_id IS NULL OR business_id = _business_id OR business_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'No opening balances to migrate';
  END IF;

  -- Generate entry number
  SELECT 'OB-' || LPAD((COALESCE(MAX(CAST(NULLIF(SUBSTRING(entry_number FROM 'OB-(\d+)'), '') AS int)), 0) + 1)::text, 4, '0')
  INTO _entry_number
  FROM journal_entries
  WHERE organization_id = _org_id AND entry_number LIKE 'OB-%';

  IF _entry_number IS NULL THEN
    _entry_number := 'OB-0001';
  END IF;

  -- Create journal entry
  INSERT INTO journal_entries (organization_id, business_id, entry_number, entry_date, description, status, source_type)
  VALUES (_org_id, _business_id, _entry_number, _entry_date, 'Opening Balance Migration (auto-generated from account opening balances)', 'posted', 'opening_balance')
  RETURNING id INTO _je_id;

  -- Create lines for each account with opening_balance
  FOR _acct IN
    SELECT id, account_type, opening_balance
    FROM accounts
    WHERE organization_id = _org_id
      AND is_active = true
      AND opening_balance != 0
      AND (_business_id IS NULL OR business_id = _business_id OR business_id IS NULL)
    ORDER BY code
  LOOP
    _line_order := _line_order + 1;

    -- Determine debit/credit based on account type and balance sign
    IF _acct.account_type IN ('asset', 'expense') THEN
      -- Debit-normal accounts: positive OB = debit, negative OB = credit
      IF _acct.opening_balance >= 0 THEN
        _debit := _acct.opening_balance;
        _credit := 0;
      ELSE
        _debit := 0;
        _credit := ABS(_acct.opening_balance);
      END IF;
    ELSE
      -- Credit-normal accounts (liability, equity, income): positive OB = credit, negative OB = debit
      IF _acct.opening_balance >= 0 THEN
        _debit := 0;
        _credit := _acct.opening_balance;
      ELSE
        _debit := ABS(_acct.opening_balance);
        _credit := 0;
      END IF;
    END IF;

    _total_debit := _total_debit + _debit;
    _total_credit := _total_credit + _credit;

    INSERT INTO journal_entry_lines (journal_entry_id, account_id, description, debit, credit, sort_order)
    VALUES (_je_id, _acct.id, 'Opening balance', _debit, _credit, _line_order);

    -- Zero out the opening_balance on the account
    UPDATE accounts SET opening_balance = 0, updated_at = now() WHERE id = _acct.id;
  END LOOP;

  -- If imbalanced, add a suspense line to a "Opening Balance Equity" or the first equity account
  IF _total_debit != _total_credit THEN
    _line_order := _line_order + 1;
    DECLARE
      _suspense_account_id uuid;
      _diff numeric := _total_debit - _total_credit;
    BEGIN
      -- Find an equity account to absorb the difference
      SELECT id INTO _suspense_account_id
      FROM accounts
      WHERE organization_id = _org_id
        AND account_type = 'equity'
        AND is_active = true
      ORDER BY code
      LIMIT 1;

      IF _suspense_account_id IS NULL THEN
        RAISE EXCEPTION 'No equity account found to absorb opening balance difference of %', _diff;
      END IF;

      IF _diff > 0 THEN
        -- More debits than credits → need a credit
        INSERT INTO journal_entry_lines (journal_entry_id, account_id, description, debit, credit, sort_order)
        VALUES (_je_id, _suspense_account_id, 'Opening balance adjustment (auto-balancing)', 0, _diff, _line_order);
      ELSE
        -- More credits than debits → need a debit
        INSERT INTO journal_entry_lines (journal_entry_id, account_id, description, debit, credit, sort_order)
        VALUES (_je_id, _suspense_account_id, 'Opening balance adjustment (auto-balancing)', ABS(_diff), 0, _line_order);
      END IF;
    END;
  END IF;

  RETURN _je_id;
END;
$$;


CREATE OR REPLACE FUNCTION public.void_journal_entry_atomic(
  _entry_id uuid,
  _reason text,
  _user_id uuid DEFAULT NULL,
  _entry_number text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _original RECORD;
  _reversal_id uuid := gen_random_uuid();
  _line RECORD;
  _now timestamptz := now();
  _org_id uuid;
  _business_id uuid;
  _final_entry_number text;
BEGIN
  -- 1. Fetch and lock the original entry
  SELECT * INTO _original
  FROM journal_entries
  WHERE id = _entry_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal entry not found: %', _entry_id;
  END IF;

  -- 2. Guard checks
  IF _original.status = 'reversed' THEN
    RAISE EXCEPTION 'This journal entry has already been reversed.';
  END IF;
  IF _original.status = 'voided' THEN
    RAISE EXCEPTION 'This journal entry has already been voided.';
  END IF;
  IF _original.status != 'posted' THEN
    RAISE EXCEPTION 'Cannot void a % journal entry.', _original.status;
  END IF;
  IF _original.is_reversal = true OR _original.reversal_of_id IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot void a reversal journal entry.';
  END IF;

  _org_id := _original.organization_id;
  _business_id := _original.business_id;

  -- 3. Generate entry number if not provided
  IF _entry_number IS NULL THEN
    SELECT COALESCE(
      'JE-' || LPAD((COALESCE(MAX(NULLIF(regexp_replace(entry_number, '[^0-9]', '', 'g'), ''))::int, 0) + 1)::text, 5, '0'),
      'JE-00001'
    ) INTO _final_entry_number
    FROM journal_entries
    WHERE organization_id = _org_id;
  ELSE
    _final_entry_number := _entry_number;
  END IF;

  -- 4. Create the reversal journal entry (posted immediately)
  INSERT INTO journal_entries (
    id, organization_id, business_id, entry_number, entry_date,
    description, reference, status, posted_at, posted_by, created_by,
    source_type, source_id, is_reversal, is_reversing, reversal_of_id,
    void_reason, created_at, updated_at
  ) VALUES (
    _reversal_id, _org_id, _business_id, _final_entry_number,
    CURRENT_DATE,
    'Void of ' || _original.entry_number || ': ' || _reason,
    _original.reference,
    'posted', _now, _user_id, _user_id,
    'void', _entry_id,
    true, true, _entry_id,
    _reason, _now, _now
  );

  -- 5. Create reversed lines (flip debit/credit) and update account balances
  FOR _line IN
    SELECT * FROM journal_entry_lines WHERE journal_entry_id = _entry_id ORDER BY sort_order
  LOOP
    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, description, debit, credit, contact_id, sort_order, created_at
    ) VALUES (
      _reversal_id, _line.account_id,
      'VOID: ' || COALESCE(_line.description, ''),
      COALESCE(_line.credit, 0),  -- flip
      COALESCE(_line.debit, 0),   -- flip
      _line.contact_id, _line.sort_order, _now
    );

    -- Update account current_balance (reverse the original impact)
    UPDATE accounts
    SET current_balance = COALESCE(current_balance, 0) + COALESCE(_line.credit, 0) - COALESCE(_line.debit, 0),
        updated_at = _now
    WHERE id = _line.account_id;
  END LOOP;

  -- 6. Mark original entry as reversed
  UPDATE journal_entries
  SET status = 'reversed',
      reversed_by_id = _reversal_id,
      voided_at = _now,
      voided_by = _user_id,
      void_reason = _reason,
      updated_at = _now
  WHERE id = _entry_id;

  RETURN _reversal_id;
END;
$$;

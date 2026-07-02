
-- P0-3: Atomic draft journal entry creation function
-- Ensures header + lines are created in a single transaction
CREATE OR REPLACE FUNCTION public.create_journal_entry_atomic(
  _org_id uuid,
  _business_id uuid,
  _entry_number text,
  _entry_date date,
  _description text,
  _reference text DEFAULT NULL,
  _is_adjusting boolean DEFAULT false,
  _is_closing boolean DEFAULT false,
  _created_by uuid DEFAULT NULL,
  _lines jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _entry_id uuid;
  _line jsonb;
  _total_debit numeric := 0;
  _total_credit numeric := 0;
  _sort integer := 0;
BEGIN
  -- Validate balance
  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    _total_debit := _total_debit + COALESCE((_line->>'debit')::numeric, 0);
    _total_credit := _total_credit + COALESCE((_line->>'credit')::numeric, 0);
  END LOOP;

  IF ABS(_total_debit - _total_credit) > 0.01 THEN
    RAISE EXCEPTION 'Journal entry is not balanced: debits (%) != credits (%)', _total_debit, _total_credit;
  END IF;

  -- Insert header
  INSERT INTO journal_entries (
    organization_id, business_id, entry_number, entry_date,
    description, reference, is_adjusting, is_closing,
    status, created_by
  ) VALUES (
    _org_id, _business_id, _entry_number, _entry_date,
    _description, _reference, _is_adjusting, _is_closing,
    'draft', _created_by
  )
  RETURNING id INTO _entry_id;

  -- Insert lines
  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, description,
      debit, credit, contact_id, sort_order
    ) VALUES (
      _entry_id,
      (_line->>'account_id')::uuid,
      _line->>'description',
      COALESCE((_line->>'debit')::numeric, 0),
      COALESCE((_line->>'credit')::numeric, 0),
      CASE WHEN _line->>'contact_id' IS NOT NULL THEN (_line->>'contact_id')::uuid ELSE NULL END,
      _sort
    );
    _sort := _sort + 1;
  END LOOP;

  RETURN _entry_id;
END;
$$;

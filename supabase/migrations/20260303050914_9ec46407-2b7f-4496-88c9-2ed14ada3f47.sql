-- Fix: cast _source_id from text to uuid in post_journal_entry_atomic
CREATE OR REPLACE FUNCTION public.post_journal_entry_atomic(
  _org_id uuid, _business_id uuid, _entry_number text, _entry_date date,
  _reference text, _description text, _source_type text, _source_id text,
  _created_by uuid, _is_closing boolean DEFAULT false, _is_adjusting boolean DEFAULT false,
  _lines jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _je_id UUID;
  _total_debit NUMERIC := 0;
  _total_credit NUMERIC := 0;
  _line JSONB;
  _sort INT := 0;
BEGIN
  IF jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'Journal entry must have at least one line';
  END IF;

  SELECT
    COALESCE(SUM((l->>'debit')::NUMERIC), 0),
    COALESCE(SUM((l->>'credit')::NUMERIC), 0)
  INTO _total_debit, _total_credit
  FROM jsonb_array_elements(_lines) AS l;

  IF ABS(_total_debit - _total_credit) > 0.001 THEN
    RAISE EXCEPTION 'Debits (%) must equal Credits (%)', _total_debit, _total_credit;
  END IF;

  INSERT INTO journal_entries (
    organization_id, business_id, entry_number, entry_date,
    reference, description, source_type, source_id,
    status, is_closing, is_adjusting,
    created_by, posted_at, posted_by
  ) VALUES (
    _org_id, _business_id, _entry_number, _entry_date,
    _reference, _description, _source_type, _source_id::UUID,
    'posted', _is_closing, _is_adjusting,
    _created_by, NOW(), _created_by
  )
  RETURNING id INTO _je_id;

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
$function$;
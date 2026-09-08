CREATE OR REPLACE FUNCTION public.void_journal_entry_atomic(_entry_id uuid, _reason text, _user_id uuid DEFAULT NULL::uuid, _entry_number text DEFAULT NULL::text, _reversal_date date DEFAULT NULL::date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _original RECORD;
  _reversal_id uuid := gen_random_uuid();
  _line RECORD;
  _now timestamptz := now();
  _org_id uuid;
  _business_id uuid;
  _final_entry_number text;
  _final_reversal_date date;
  _existing_reversal uuid;
  _reversal_subtype text;
  _tot_debit numeric;
  _tot_credit numeric;
  _prev_suppress text;
BEGIN
  SELECT * INTO _original FROM journal_entries WHERE id = _entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal entry not found: %', _entry_id;
  END IF;

  IF _original.status = 'void' AND _original.reversed_by_id IS NOT NULL THEN
    RETURN _original.reversed_by_id;
  END IF;

  IF _original.status = 'void' THEN
    RAISE EXCEPTION 'This journal entry has already been voided.';
  END IF;
  IF _original.status <> 'posted' THEN
    RAISE EXCEPTION 'Cannot void a % journal entry.', _original.status;
  END IF;
  IF _original.is_reversal = true OR _original.reversal_of_id IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot void a reversal journal entry.';
  END IF;

  _reversal_subtype := CASE
    WHEN _original.source_subtype IS NULL OR _original.source_subtype = '' THEN 'reversal'
    ELSE 'reversal:' || _original.source_subtype
  END;

  IF _original.source_type IS NOT NULL AND _original.source_id IS NOT NULL THEN
    SELECT id INTO _existing_reversal
    FROM journal_entries
    WHERE organization_id = _original.organization_id
      AND source_type = _original.source_type
      AND source_id = _original.source_id
      AND source_subtype = _reversal_subtype
      AND status <> 'void'
    LIMIT 1;
    IF _existing_reversal IS NOT NULL THEN
      UPDATE journal_entries
      SET status = 'void', reversed_by_id = _existing_reversal, updated_at = _now
      WHERE id = _entry_id AND status = 'posted';
      RETURN _existing_reversal;
    END IF;
  END IF;

  _org_id := _original.organization_id;
  _business_id := _original.business_id;
  _final_reversal_date := COALESCE(_reversal_date, CURRENT_DATE);

  IF _entry_number IS NULL THEN
    SELECT COALESCE(
      'JE-' || LPAD((COALESCE(MAX(NULLIF(regexp_replace(entry_number, '[^0-9]', '', 'g'), ''))::int, 0) + 1)::text, 5, '0'),
      'JE-00001'
    ) INTO _final_entry_number
    FROM journal_entries WHERE organization_id = _org_id;
  ELSE
    _final_entry_number := _entry_number;
  END IF;

  SELECT COALESCE(SUM(COALESCE(credit, 0)), 0), COALESCE(SUM(COALESCE(debit, 0)), 0)
    INTO _tot_debit, _tot_credit
  FROM journal_entry_lines WHERE journal_entry_id = _entry_id;

  INSERT INTO journal_entries (
    id, organization_id, business_id, branch_id, journal_book_id,
    entry_number, entry_date,
    description, reference, status, posted_at, posted_by, created_by,
    source_type, source_id, source_subtype,
    is_reversal, is_reversing, reversal_of_id,
    total_debit, total_credit,
    void_reason, created_at, updated_at
  ) VALUES (
    _reversal_id, _org_id, _business_id, _original.branch_id, _original.journal_book_id,
    _final_entry_number,
    _final_reversal_date,
    'Reversal of ' || _original.entry_number || ': ' || _reason,
    _original.reference,
    'posted', _now, _user_id, _user_id,
    COALESCE(_original.source_type, 'void'),
    COALESCE(_original.source_id, _entry_id),
    _reversal_subtype,
    true, true, _entry_id,
    _tot_debit, _tot_credit,
    _reason, _now, _now
  );

  _prev_suppress := COALESCE(current_setting('app.suppress_je_recompute', true), '');
  PERFORM set_config('app.suppress_je_recompute', 'on', true);

  FOR _line IN
    SELECT * FROM journal_entry_lines WHERE journal_entry_id = _entry_id ORDER BY sort_order
  LOOP
    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, description, debit, credit, contact_id, sort_order, created_at
    ) VALUES (
      _reversal_id, _line.account_id,
      'REVERSAL: ' || COALESCE(_line.description, ''),
      COALESCE(_line.credit, 0),
      COALESCE(_line.debit, 0),
      _line.contact_id, _line.sort_order, _now
    );
  END LOOP;

  PERFORM set_config('app.suppress_je_recompute', _prev_suppress, true);

  UPDATE journal_entries
  SET status = 'void',
      reversed_by_id = _reversal_id,
      voided_at = _now,
      voided_by = _user_id,
      void_reason = _reason,
      updated_at = _now
  WHERE id = _entry_id;

  RETURN _reversal_id;
END;
$function$;

-- Backfill: existing reversal entries inherit the branch of the entry they reverse.
-- Rollback: UPDATE journal_entries SET branch_id = NULL WHERE id IN (the ids touched below);
DO $$
BEGIN
  PERFORM set_config('app.je_lineage_repair', 'on', true);
  UPDATE journal_entries r
  SET branch_id = o.branch_id, updated_at = now()
  FROM journal_entries o
  WHERE r.reversal_of_id = o.id
    AND r.branch_id IS NULL
    AND o.branch_id IS NOT NULL;
  PERFORM set_config('app.je_lineage_repair', '', true);
END $$;
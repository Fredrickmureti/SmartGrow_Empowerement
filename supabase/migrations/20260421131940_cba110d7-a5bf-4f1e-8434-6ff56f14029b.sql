-- Stage 2 + Stage 3 prep: branch_id propagation in JE RPCs + scoped resolver helper.

-- 1) Update create_journal_entry_atomic to accept _branch_id and stamp it on header + lines.
CREATE OR REPLACE FUNCTION public.create_journal_entry_atomic(
  _org_id uuid,
  _business_id uuid,
  _entry_number text,
  _entry_date date,
  _description text,
  _reference text,
  _is_adjusting boolean,
  _is_closing boolean,
  _created_by uuid,
  _lines jsonb,
  _branch_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _entry_id uuid;
  _line jsonb;
  _total_debit numeric := 0;
  _total_credit numeric := 0;
  _sort integer := 0;
BEGIN
  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    _total_debit := _total_debit + COALESCE((_line->>'debit')::numeric, 0);
    _total_credit := _total_credit + COALESCE((_line->>'credit')::numeric, 0);
  END LOOP;

  IF ABS(_total_debit - _total_credit) > 0.01 THEN
    RAISE EXCEPTION 'Journal entry is not balanced: debits (%) != credits (%)', _total_debit, _total_credit;
  END IF;

  INSERT INTO journal_entries (
    organization_id, business_id, branch_id, entry_number, entry_date,
    description, reference, is_adjusting, is_closing,
    status, created_by
  ) VALUES (
    _org_id, _business_id, _branch_id, _entry_number, _entry_date,
    _description, _reference, _is_adjusting, _is_closing,
    'posted', _created_by
  )
  RETURNING id INTO _entry_id;

  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, description,
      debit, credit, contact_id, sort_order, branch_id
    ) VALUES (
      _entry_id,
      (_line->>'account_id')::uuid,
      _line->>'description',
      COALESCE((_line->>'debit')::numeric, 0),
      COALESCE((_line->>'credit')::numeric, 0),
      CASE WHEN _line->>'contact_id' IS NOT NULL THEN (_line->>'contact_id')::uuid ELSE NULL END,
      _sort,
      _branch_id
    );
    _sort := _sort + 1;
  END LOOP;

  RETURN _entry_id;
END;
$function$;

-- 2) Update post_journal_entry_atomic similarly. Re-create with same shape + new param.
-- We need its full body; rewrite preserving existing behavior.
CREATE OR REPLACE FUNCTION public.post_journal_entry_atomic(
  _org_id uuid,
  _business_id uuid,
  _entry_number text,
  _entry_date date,
  _reference text,
  _description text,
  _source_type text,
  _source_id uuid,
  _created_by uuid,
  _is_closing boolean,
  _is_adjusting boolean,
  _lines jsonb,
  _currency text DEFAULT NULL,
  _exchange_rate numeric DEFAULT NULL,
  _source_subtype text DEFAULT NULL,
  _branch_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _entry_id uuid;
  _line jsonb;
  _total_debit numeric := 0;
  _total_credit numeric := 0;
  _sort integer := 0;
BEGIN
  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    _total_debit := _total_debit + COALESCE((_line->>'debit')::numeric, 0);
    _total_credit := _total_credit + COALESCE((_line->>'credit')::numeric, 0);
  END LOOP;

  IF ABS(_total_debit - _total_credit) > 0.001 THEN
    RAISE EXCEPTION 'Journal entry is not balanced: debits (%) != credits (%)', _total_debit, _total_credit;
  END IF;

  INSERT INTO journal_entries (
    organization_id, business_id, branch_id, entry_number, entry_date,
    description, reference, source_type, source_id, source_subtype,
    is_adjusting, is_closing, status, created_by, currency, exchange_rate
  ) VALUES (
    _org_id, _business_id, _branch_id, _entry_number, _entry_date,
    _description, _reference, _source_type, _source_id, _source_subtype,
    _is_adjusting, _is_closing, 'posted', _created_by, _currency, _exchange_rate
  )
  RETURNING id INTO _entry_id;

  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, description,
      debit, credit, contact_id, analytic_account_id, exchange_rate,
      sort_order, branch_id
    ) VALUES (
      _entry_id,
      (_line->>'account_id')::uuid,
      _line->>'description',
      COALESCE((_line->>'debit')::numeric, 0),
      COALESCE((_line->>'credit')::numeric, 0),
      CASE WHEN _line->>'contact_id' IS NOT NULL THEN (_line->>'contact_id')::uuid ELSE NULL END,
      CASE WHEN _line->>'analytic_account_id' IS NOT NULL THEN (_line->>'analytic_account_id')::uuid ELSE NULL END,
      CASE WHEN _line->>'exchange_rate' IS NOT NULL THEN (_line->>'exchange_rate')::numeric ELSE NULL END,
      _sort,
      _branch_id
    );
    _sort := _sort + 1;
  END LOOP;

  RETURN _entry_id;
END;
$function$;

-- 3) Branch-scoped resolver helper.
-- Returns rows where branch_id = _branch_id (override) OR branch_id IS NULL (shared),
-- ordered "specific first" so callers can pick the first match as the effective record.
CREATE OR REPLACE FUNCTION public.resolve_branch_scoped(
  _table_name text,
  _business_id uuid,
  _branch_id uuid
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _allowed text[] := ARRAY[
    'bank_accounts',
    'organization_payment_methods',
    'document_templates'
  ];
  _sql text;
BEGIN
  IF NOT (_table_name = ANY(_allowed)) THEN
    RAISE EXCEPTION 'resolve_branch_scoped: table % is not in the branch-scoped allowlist', _table_name;
  END IF;

  _sql := format(
    'SELECT to_jsonb(t) FROM public.%I t
       WHERE t.business_id = %L
         AND (t.branch_id = %L OR t.branch_id IS NULL)
       ORDER BY (t.branch_id IS NULL) ASC',  -- non-null (override) first
    _table_name, _business_id, _branch_id
  );
  RETURN QUERY EXECUTE _sql;
END;
$function$;
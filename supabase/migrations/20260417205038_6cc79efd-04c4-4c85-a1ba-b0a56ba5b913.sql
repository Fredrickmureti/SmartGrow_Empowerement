-- Stage 1: Repair the journal entry posting pipeline

-- 1. Add source_subtype column to journal_entries to distinguish sub-entries
ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS source_subtype text;

COMMENT ON COLUMN public.journal_entries.source_subtype IS
  'Distinguishes sub-entries that share the same source document (e.g. ''main'', ''cogs'', ''wht'', ''writeoff'', ''service_charge'', ''interest'', ''reversal''). NULL is treated as ''main''.';

-- 2. Replace the unique index so main + sub-entries can coexist for the same source document
DROP INDEX IF EXISTS public.idx_journal_entries_source_unique;

CREATE UNIQUE INDEX idx_journal_entries_source_unique
  ON public.journal_entries (
    organization_id,
    source_type,
    source_id,
    COALESCE(source_subtype, 'main')
  )
  WHERE source_id IS NOT NULL
    AND source_type IS NOT NULL
    AND status <> 'voided';

-- 3. Drop ALL existing overloads of post_journal_entry_atomic to ensure a single clean signature
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT oid::regprocedure AS sig
    FROM pg_proc
    WHERE proname = 'post_journal_entry_atomic'
      AND pronamespace = 'public'::regnamespace
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig || ' CASCADE';
  END LOOP;
END $$;

-- 4. Recreate post_journal_entry_atomic with correct UUID typing and source_subtype support
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
  _source_subtype text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry_id uuid;
  v_line jsonb;
  v_total_debit numeric := 0;
  v_total_credit numeric := 0;
  v_existing_id uuid;
BEGIN
  -- Idempotency: if a non-voided entry already exists for this (org, source_type, source_id, subtype), return it
  IF _source_type IS NOT NULL AND _source_id IS NOT NULL THEN
    SELECT id INTO v_existing_id
    FROM public.journal_entries
    WHERE organization_id = _org_id
      AND source_type = _source_type
      AND source_id = _source_id
      AND COALESCE(source_subtype, 'main') = COALESCE(_source_subtype, 'main')
      AND status <> 'voided'
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      RETURN v_existing_id;
    END IF;
  END IF;

  -- Validate lines
  IF _lines IS NULL OR jsonb_array_length(_lines) < 2 THEN
    RAISE EXCEPTION 'Journal entry requires at least 2 lines';
  END IF;

  -- Compute totals
  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines)
  LOOP
    v_total_debit := v_total_debit + COALESCE((v_line->>'debit')::numeric, 0);
    v_total_credit := v_total_credit + COALESCE((v_line->>'credit')::numeric, 0);
  END LOOP;

  -- Validate balance (allow 0.01 rounding tolerance)
  IF ABS(v_total_debit - v_total_credit) > 0.01 THEN
    RAISE EXCEPTION 'Journal entry not balanced: debit=% credit=%', v_total_debit, v_total_credit;
  END IF;

  -- Insert header
  INSERT INTO public.journal_entries (
    organization_id,
    business_id,
    entry_number,
    entry_date,
    reference,
    description,
    source_type,
    source_id,
    source_subtype,
    created_by,
    is_closing_entry,
    is_adjusting_entry,
    status,
    total_debit,
    total_credit,
    posted_at,
    posted_by
  ) VALUES (
    _org_id,
    _business_id,
    _entry_number,
    _entry_date,
    _reference,
    _description,
    _source_type,
    _source_id,
    _source_subtype,
    _created_by,
    COALESCE(_is_closing, false),
    COALESCE(_is_adjusting, false),
    'posted',
    v_total_debit,
    v_total_credit,
    now(),
    _created_by
  )
  RETURNING id INTO v_entry_id;

  -- Insert lines
  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines)
  LOOP
    INSERT INTO public.journal_entry_lines (
      journal_entry_id,
      account_id,
      debit,
      credit,
      description
    ) VALUES (
      v_entry_id,
      (v_line->>'account_id')::uuid,
      COALESCE((v_line->>'debit')::numeric, 0),
      COALESCE((v_line->>'credit')::numeric, 0),
      v_line->>'description'
    );
  END LOOP;

  RETURN v_entry_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.post_journal_entry_atomic(
  uuid, uuid, text, date, text, text, text, uuid, uuid, boolean, boolean, jsonb, text
) TO authenticated, service_role;

COMMENT ON FUNCTION public.post_journal_entry_atomic IS
  'Atomically posts a journal entry with its lines. Source_id MUST be a real UUID (not a prefixed string). Use _source_subtype to distinguish sub-entries (e.g. ''cogs'') sharing the same source document.';
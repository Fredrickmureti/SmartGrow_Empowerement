-- Drop and recreate post_journal_entry_atomic with full multi-currency + line metadata support

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
  v_idx int := 0;
BEGIN
  -- Idempotency
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

  IF _lines IS NULL OR jsonb_array_length(_lines) < 2 THEN
    RAISE EXCEPTION 'Journal entry requires at least 2 lines';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines)
  LOOP
    v_total_debit := v_total_debit + COALESCE((v_line->>'debit')::numeric, 0);
    v_total_credit := v_total_credit + COALESCE((v_line->>'credit')::numeric, 0);
  END LOOP;

  IF ABS(v_total_debit - v_total_credit) > 0.01 THEN
    RAISE EXCEPTION 'Journal entry not balanced: debit=% credit=%', v_total_debit, v_total_credit;
  END IF;

  INSERT INTO public.journal_entries (
    organization_id, business_id, entry_number, entry_date, reference, description,
    source_type, source_id, source_subtype, created_by,
    is_closing_entry, is_adjusting_entry, status,
    total_debit, total_credit, posted_at, posted_by,
    currency, exchange_rate
  ) VALUES (
    _org_id, _business_id, _entry_number, _entry_date, _reference, _description,
    _source_type, _source_id, _source_subtype, _created_by,
    COALESCE(_is_closing, false), COALESCE(_is_adjusting, false), 'posted',
    v_total_debit, v_total_credit, now(), _created_by,
    _currency, _exchange_rate
  )
  RETURNING id INTO v_entry_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines)
  LOOP
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, account_id, debit, credit, description,
      contact_id, analytic_account_id, exchange_rate, sort_order
    ) VALUES (
      v_entry_id,
      (v_line->>'account_id')::uuid,
      COALESCE((v_line->>'debit')::numeric, 0),
      COALESCE((v_line->>'credit')::numeric, 0),
      v_line->>'description',
      NULLIF(v_line->>'contact_id','')::uuid,
      NULLIF(v_line->>'analytic_account_id','')::uuid,
      NULLIF(v_line->>'exchange_rate','')::numeric,
      COALESCE((v_line->>'sort_order')::int, v_idx)
    );
    v_idx := v_idx + 1;
  END LOOP;

  RETURN v_entry_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.post_journal_entry_atomic(
  uuid, uuid, text, date, text, text, text, uuid, uuid, boolean, boolean, jsonb, text, numeric, text
) TO authenticated, service_role;

COMMENT ON FUNCTION public.post_journal_entry_atomic IS
  'Atomically posts a balanced journal entry with its lines. _source_id MUST be a real UUID. Use _source_subtype to distinguish sub-entries (e.g. ''cogs'') sharing the same source document.';
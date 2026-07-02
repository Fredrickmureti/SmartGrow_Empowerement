-- Idempotent re-run
ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS total_debit numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_credit numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_adjusting_entry boolean NOT NULL DEFAULT false;

UPDATE public.journal_entries je
SET total_debit  = COALESCE(s.td, 0),
    total_credit = COALESCE(s.tc, 0)
FROM (
  SELECT journal_entry_id, SUM(debit) AS td, SUM(credit) AS tc
  FROM public.journal_entry_lines
  GROUP BY journal_entry_id
) s
WHERE je.id = s.journal_entry_id
  AND (je.total_debit = 0 AND je.total_credit = 0);

COMMENT ON COLUMN public.journal_entries.is_closing
  IS 'Deprecated: use is_closing_entry. Retained for backward compatibility.';
COMMENT ON COLUMN public.journal_entries.is_adjusting
  IS 'Deprecated: use is_adjusting_entry. Retained for backward compatibility.';

CREATE OR REPLACE FUNCTION public.enforce_je_balanced()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ABS(COALESCE(NEW.total_debit, 0) - COALESCE(NEW.total_credit, 0)) > 0.01 THEN
    RAISE EXCEPTION 'Journal entry % not balanced: debit=%, credit=%',
      NEW.entry_number, NEW.total_debit, NEW.total_credit;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_je_enforce_balanced ON public.journal_entries;
CREATE TRIGGER trg_je_enforce_balanced
  BEFORE INSERT OR UPDATE OF total_debit, total_credit ON public.journal_entries
  FOR EACH ROW
  WHEN (NEW.status = 'posted')
  EXECUTE FUNCTION public.enforce_je_balanced();

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
  _currency text DEFAULT NULL::text,
  _exchange_rate numeric DEFAULT NULL::numeric,
  _source_subtype text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_entry_id uuid;
  v_line jsonb;
  v_total_debit numeric := 0;
  v_total_credit numeric := 0;
  v_existing_id uuid;
  v_idx int := 0;
  v_fiscal_period_id uuid;
  v_line_debit numeric;
  v_line_credit numeric;
BEGIN
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

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    v_total_debit := v_total_debit + COALESCE((v_line->>'debit')::numeric, 0);
    v_total_credit := v_total_credit + COALESCE((v_line->>'credit')::numeric, 0);
  END LOOP;

  IF ABS(v_total_debit - v_total_credit) > 0.01 THEN
    RAISE EXCEPTION 'Journal entry not balanced: debit=% credit=%', v_total_debit, v_total_credit;
  END IF;

  BEGIN
    SELECT id INTO v_fiscal_period_id
    FROM public.fiscal_periods
    WHERE organization_id = _org_id
      AND _entry_date BETWEEN start_date AND end_date
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_fiscal_period_id := NULL;
  END;

  INSERT INTO public.journal_entries (
    organization_id, business_id, entry_number, entry_date, reference, description,
    source_type, source_id, source_subtype, created_by,
    is_closing_entry, is_adjusting_entry,
    is_closing, is_adjusting,
    status,
    total_debit, total_credit, posted_at, posted_by,
    currency, exchange_rate, fiscal_period_id
  ) VALUES (
    _org_id, _business_id, _entry_number, _entry_date, _reference, _description,
    _source_type, _source_id, _source_subtype, _created_by,
    COALESCE(_is_closing, false), COALESCE(_is_adjusting, false),
    COALESCE(_is_closing, false), COALESCE(_is_adjusting, false),
    'posted',
    v_total_debit, v_total_credit, now(), _created_by,
    _currency, _exchange_rate, v_fiscal_period_id
  )
  RETURNING id INTO v_entry_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    v_line_debit  := COALESCE((v_line->>'debit')::numeric, 0);
    v_line_credit := COALESCE((v_line->>'credit')::numeric, 0);

    INSERT INTO public.journal_entry_lines (
      journal_entry_id, account_id, debit, credit, description,
      contact_id, analytic_account_id, exchange_rate, sort_order,
      original_currency, original_debit, original_credit
    ) VALUES (
      v_entry_id,
      (v_line->>'account_id')::uuid,
      v_line_debit,
      v_line_credit,
      v_line->>'description',
      NULLIF(v_line->>'contact_id','')::uuid,
      NULLIF(v_line->>'analytic_account_id','')::uuid,
      COALESCE(NULLIF(v_line->>'exchange_rate','')::numeric, _exchange_rate),
      COALESCE((v_line->>'sort_order')::int, v_idx),
      _currency,
      CASE WHEN _currency IS NOT NULL THEN v_line_debit  ELSE NULL END,
      CASE WHEN _currency IS NOT NULL THEN v_line_credit ELSE NULL END
    );
    v_idx := v_idx + 1;
  END LOOP;

  RETURN v_entry_id;
END;
$function$;

-- Self-check: verify every column referenced by the RPC exists.
DO $$
DECLARE
  v_missing text;
  v_je_cols text[] := ARRAY[
    'organization_id','business_id','entry_number','entry_date','reference','description',
    'source_type','source_id','source_subtype','created_by',
    'is_closing_entry','is_adjusting_entry','is_closing','is_adjusting',
    'status','total_debit','total_credit','posted_at','posted_by',
    'currency','exchange_rate','fiscal_period_id'
  ];
  v_jel_cols text[] := ARRAY[
    'journal_entry_id','account_id','debit','credit','description',
    'contact_id','analytic_account_id','exchange_rate','sort_order',
    'original_currency','original_debit','original_credit'
  ];
  c text;
BEGIN
  FOREACH c IN ARRAY v_je_cols LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='journal_entries' AND column_name=c
    ) THEN
      v_missing := COALESCE(v_missing||', ','') || 'journal_entries.'||c;
    END IF;
  END LOOP;
  FOREACH c IN ARRAY v_jel_cols LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='journal_entry_lines' AND column_name=c
    ) THEN
      v_missing := COALESCE(v_missing||', ','') || 'journal_entry_lines.'||c;
    END IF;
  END LOOP;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Schema self-check FAILED. Missing columns: %', v_missing;
  END IF;
END $$;
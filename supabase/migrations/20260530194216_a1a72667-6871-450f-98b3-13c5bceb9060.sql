-- The deferred constraint trigger trg_enforce_je_balanced fires once per
-- UPDATE event with that event's NEW snapshot. _recompute_je_totals
-- issues an UPDATE after every line insert, so the FIRST line produces a
-- snapshot with debit=0,credit=X (or vice versa) which trips balance
-- enforcement at commit.
--
-- Fix: let post_journal_entry_atomic set a session-local flag that tells
-- _recompute_je_totals to no-op. The helper then writes the (already
-- pre-validated) final totals in one statement, so no intermediate
-- unbalanced UPDATE events are ever queued.

CREATE OR REPLACE FUNCTION public._recompute_je_totals()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  je_id uuid;
  v_suppress text;
BEGIN
  v_suppress := current_setting('app.suppress_je_recompute', true);
  IF v_suppress = 'on' THEN
    RETURN NULL;
  END IF;

  je_id := COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);
  IF je_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.journal_entries je
     SET total_debit  = COALESCE((SELECT SUM(debit)  FROM public.journal_entry_lines WHERE journal_entry_id = je_id), 0),
         total_credit = COALESCE((SELECT SUM(credit) FROM public.journal_entry_lines WHERE journal_entry_id = je_id), 0)
   WHERE je.id = je_id
     AND (je.total_debit  IS DISTINCT FROM COALESCE((SELECT SUM(debit)  FROM public.journal_entry_lines WHERE journal_entry_id = je_id), 0)
       OR je.total_credit IS DISTINCT FROM COALESCE((SELECT SUM(credit) FROM public.journal_entry_lines WHERE journal_entry_id = je_id), 0));

  RETURN NULL;
END;
$function$;

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
  _source_subtype text DEFAULT NULL::text,
  _branch_id uuid DEFAULT NULL::uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_entry_id     uuid;
  v_line         jsonb;
  v_total_debit  numeric := 0;
  v_total_credit numeric := 0;
  v_existing_id  uuid;
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
    v_total_debit  := v_total_debit  + COALESCE((v_line->>'debit')::numeric,  0);
    v_total_credit := v_total_credit + COALESCE((v_line->>'credit')::numeric, 0);
  END LOOP;

  IF ABS(v_total_debit - v_total_credit) > 0.01 THEN
    RAISE EXCEPTION 'Journal entry not balanced: debit=% credit=%', v_total_debit, v_total_credit;
  END IF;

  -- Suppress the per-line totals-recompute trigger for the duration of
  -- this transaction; we will write the final, pre-validated totals in
  -- the same INSERT and never have an intermediate unbalanced snapshot.
  PERFORM set_config('app.suppress_je_recompute', 'on', true);

  INSERT INTO public.journal_entries (
    organization_id, business_id, branch_id,
    entry_number, entry_date, reference, description,
    source_type, source_id, source_subtype,
    created_by, is_closing_entry, is_adjusting_entry,
    status, total_debit, total_credit,
    currency, exchange_rate,
    posted_at, posted_by
  ) VALUES (
    _org_id, _business_id, _branch_id,
    _entry_number, _entry_date, _reference, _description,
    _source_type, _source_id, _source_subtype,
    _created_by, COALESCE(_is_closing,false), COALESCE(_is_adjusting,false),
    'posted', v_total_debit, v_total_credit,
    _currency, _exchange_rate,
    now(), _created_by
  )
  RETURNING id INTO v_entry_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    INSERT INTO public.journal_entry_lines (
      journal_entry_id,
      organization_id, business_id, branch_id,
      account_id, debit, credit, description,
      contact_id, analytic_account_id, exchange_rate
    ) VALUES (
      v_entry_id,
      _org_id, _business_id, _branch_id,
      (v_line->>'account_id')::uuid,
      COALESCE((v_line->>'debit')::numeric,  0),
      COALESCE((v_line->>'credit')::numeric, 0),
      v_line->>'description',
      NULLIF(v_line->>'contact_id','')::uuid,
      NULLIF(v_line->>'analytic_account_id','')::uuid,
      NULLIF(v_line->>'exchange_rate','')::numeric
    );
  END LOOP;

  RETURN v_entry_id;
END;
$function$;
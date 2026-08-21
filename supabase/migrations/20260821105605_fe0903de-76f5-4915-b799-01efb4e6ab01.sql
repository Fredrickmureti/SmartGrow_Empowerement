-- Phase 2a — the posting engine becomes the single denomination authority.
--
-- Until now `post_journal_entry_atomic` never wrote `original_currency` /
-- `original_debit` / `original_credit`, and document posters handed it
-- document-currency amounts which were stored verbatim as if they were base
-- currency. A foreign-currency invoice therefore entered the ledger
-- unconverted. This adds an explicit opt-in: when a caller declares that its
-- line amounts are denominated in the document currency, the engine resolves
-- the rate through `require_exchange_rate` (ADR 0136 — never a silent 1:1),
-- stores base amounts, and stamps the original denomination on every line.
--
-- The flag defaults to false, so every caller that has not been migrated
-- keeps its current behaviour exactly.

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
  _branch_id uuid DEFAULT NULL::uuid,
  _is_opening_entry boolean DEFAULT false,
  _amounts_in_document_currency boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_entry_id     uuid;
  v_line         jsonb;
  v_total_debit  numeric := 0;
  v_total_credit numeric := 0;
  v_doc_debit    numeric := 0;
  v_doc_credit   numeric := 0;
  v_existing_id  uuid;
  v_entry_number text := NULLIF(btrim(_entry_number), '');
  v_base         text;
  v_doc_ccy      text;
  v_rate         numeric := COALESCE(_exchange_rate, 1);
  v_convert      boolean := false;
  v_norm         jsonb := '[]'::jsonb;
  v_d            numeric;
  v_c            numeric;
  v_od           numeric;
  v_oc           numeric;
  v_idx          integer := 0;
  v_max_idx      integer := 0;
  v_max_abs      numeric := -1;
  v_residual     numeric := 0;
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

  -- Denomination. The document currency is normalised against the catalogue
  -- and the rate comes from the one resolver; a missing rate raises rather
  -- than posting an unconverted foreign amount.
  SELECT b.base_currency INTO v_base FROM public.businesses b WHERE b.id = _business_id;
  v_doc_ccy := public.normalize_currency_code(_currency);

  IF COALESCE(_amounts_in_document_currency, false)
     AND v_doc_ccy IS NOT NULL AND v_base IS NOT NULL
     AND v_doc_ccy <> upper(v_base) THEN
    v_convert := true;
    IF _exchange_rate IS NULL OR _exchange_rate <= 0 THEN
      v_rate := public.require_exchange_rate(_org_id, _business_id, v_doc_ccy, _entry_date);
    ELSE
      v_rate := _exchange_rate;
    END IF;
  ELSIF _exchange_rate IS NULL OR _exchange_rate <= 0 THEN
    v_rate := 1;
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    v_idx := v_idx + 1;
    v_od := ROUND(COALESCE((v_line->>'debit')::numeric, 0), 2);
    v_oc := ROUND(COALESCE((v_line->>'credit')::numeric, 0), 2);
    v_doc_debit  := v_doc_debit  + v_od;
    v_doc_credit := v_doc_credit + v_oc;

    IF v_convert THEN
      v_d := ROUND(v_od * v_rate, 2);
      v_c := ROUND(v_oc * v_rate, 2);
    ELSE
      v_d := v_od;
      v_c := v_oc;
    END IF;

    IF GREATEST(ABS(v_d), ABS(v_c)) > v_max_abs THEN
      v_max_abs := GREATEST(ABS(v_d), ABS(v_c));
      v_max_idx := v_idx;
    END IF;

    v_norm := v_norm || jsonb_build_object(
      'account_id', v_line->>'account_id',
      'debit', v_d,
      'credit', v_c,
      'original_debit',  CASE WHEN v_convert THEN v_od ELSE NULL END,
      'original_credit', CASE WHEN v_convert THEN v_oc ELSE NULL END,
      'description', v_line->>'description',
      'contact_id', NULLIF(v_line->>'contact_id',''),
      'analytic_account_id', NULLIF(v_line->>'analytic_account_id',''),
      'exchange_rate', CASE WHEN v_convert THEN v_rate
                            ELSE NULLIF(v_line->>'exchange_rate','')::numeric END
    );

    v_total_debit  := v_total_debit  + v_d;
    v_total_credit := v_total_credit + v_c;
  END LOOP;

  -- The document must balance in its own currency.
  IF ABS(v_doc_debit - v_doc_credit) > 0.01 THEN
    RAISE EXCEPTION 'Journal entry not balanced: debit=% credit=%', v_doc_debit, v_doc_credit;
  END IF;

  -- Per-line rounding can leave a cent of residual in base currency. Absorb it
  -- on the largest line so the ledger itself is always exactly balanced.
  v_residual := ROUND(v_total_debit - v_total_credit, 2);
  IF v_convert AND v_residual <> 0 AND v_max_idx > 0 THEN
    IF ABS(v_residual) > 0.01 * jsonb_array_length(v_norm) + 0.01 THEN
      RAISE EXCEPTION 'FX conversion residual % exceeds rounding tolerance', v_residual;
    END IF;
    v_line := v_norm -> (v_max_idx - 1);
    IF (v_line->>'debit')::numeric >= (v_line->>'credit')::numeric THEN
      v_norm := jsonb_set(v_norm, ARRAY[(v_max_idx - 1)::text, 'debit'],
                          to_jsonb(ROUND((v_line->>'debit')::numeric - v_residual, 2)));
      v_total_debit := v_total_debit - v_residual;
    ELSE
      v_norm := jsonb_set(v_norm, ARRAY[(v_max_idx - 1)::text, 'credit'],
                          to_jsonb(ROUND((v_line->>'credit')::numeric + v_residual, 2)));
      v_total_credit := v_total_credit + v_residual;
    END IF;
  END IF;

  IF ABS(v_total_debit - v_total_credit) > 0.01 THEN
    RAISE EXCEPTION 'Journal entry not balanced in base currency: debit=% credit=%',
      v_total_debit, v_total_credit;
  END IF;

  -- Numbering is owned here, by the one canonical engine.
  IF v_entry_number IS NULL THEN
    IF _business_id IS NULL THEN
      RAISE EXCEPTION 'business_id is required to number a journal entry (multi-company isolation)'
        USING ERRCODE = 'null_value_not_allowed';
    END IF;
    v_entry_number := public.generate_next_je_number(_org_id, _business_id);
  END IF;

  PERFORM set_config('app.suppress_je_recompute', 'on', true);

  INSERT INTO public.journal_entries (
    organization_id, business_id, branch_id,
    entry_number, entry_date, reference, description,
    source_type, source_id, source_subtype,
    created_by, is_closing_entry, is_adjusting_entry, is_opening_entry,
    status, total_debit, total_credit,
    currency, exchange_rate,
    posted_at, posted_by
  ) VALUES (
    _org_id, _business_id, _branch_id,
    v_entry_number, _entry_date, _reference, _description,
    _source_type, _source_id, _source_subtype,
    _created_by, COALESCE(_is_closing,false), COALESCE(_is_adjusting,false),
    COALESCE(_is_opening_entry,false),
    'posted', v_total_debit, v_total_credit,
    COALESCE(v_doc_ccy, _currency), CASE WHEN v_convert THEN v_rate ELSE _exchange_rate END,
    now(), _created_by
  )
  RETURNING id INTO v_entry_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(v_norm) LOOP
    INSERT INTO public.journal_entry_lines (
      journal_entry_id,
      organization_id, business_id, branch_id,
      account_id, debit, credit, description,
      contact_id, analytic_account_id, exchange_rate,
      original_currency, original_debit, original_credit
    ) VALUES (
      v_entry_id,
      _org_id, _business_id, _branch_id,
      (v_line->>'account_id')::uuid,
      COALESCE((v_line->>'debit')::numeric,  0),
      COALESCE((v_line->>'credit')::numeric, 0),
      v_line->>'description',
      NULLIF(v_line->>'contact_id','')::uuid,
      NULLIF(v_line->>'analytic_account_id','')::uuid,
      NULLIF(v_line->>'exchange_rate','')::numeric,
      CASE WHEN v_convert THEN v_doc_ccy ELSE NULL END,
      NULLIF(v_line->>'original_debit','')::numeric,
      NULLIF(v_line->>'original_credit','')::numeric
    );
  END LOOP;

  RETURN v_entry_id;
END;
$function$;

-- Migrate the first document family: AR invoices. Patched surgically from the
-- live definition so no unrelated logic can drift.
DO $mig$
DECLARE
  v_def text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_confirm_invoice_core';

  IF v_def IS NULL THEN
    RAISE EXCEPTION '_confirm_invoice_core not found';
  END IF;

  v_new := replace(
    v_def,
    '_exchange_rate := NULL, _source_subtype := NULL, _branch_id := v_inv.branch_id',
    '_exchange_rate := NULL, _source_subtype := NULL, _branch_id := v_inv.branch_id,
    _amounts_in_document_currency := true');

  IF v_new = v_def THEN
    RAISE EXCEPTION '_confirm_invoice_core call site did not match; refusing to patch blindly';
  END IF;

  EXECUTE v_new;
END $mig$;

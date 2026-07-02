-- Fix: post_journal_entry_atomic was inserting journal_entry_lines without
-- organization_id. A NOT NULL / parent-match guard on journal_entry_lines
-- rejects every insert, surfacing as a 400 from create_product_with_opening_stock_atomic
-- and a generic "Some of the information you entered is not valid" toast.
--
-- This re-creates the function so every journal_entry_lines insert carries
-- organization_id (from _org_id), alongside the existing business_id and
-- branch_id. No behavior changes otherwise.

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

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines)
  LOOP
    v_total_debit  := v_total_debit  + COALESCE((v_line->>'debit')::numeric,  0);
    v_total_credit := v_total_credit + COALESCE((v_line->>'credit')::numeric, 0);
  END LOOP;

  IF ABS(v_total_debit - v_total_credit) > 0.01 THEN
    RAISE EXCEPTION 'Journal entry not balanced: debit=% credit=%', v_total_debit, v_total_credit;
  END IF;

  INSERT INTO public.journal_entries (
    organization_id,
    business_id,
    branch_id,
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
    currency,
    exchange_rate,
    posted_at,
    posted_by
  ) VALUES (
    _org_id,
    _business_id,
    _branch_id,
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
    _currency,
    _exchange_rate,
    now(),
    _created_by
  )
  RETURNING id INTO v_entry_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines)
  LOOP
    INSERT INTO public.journal_entry_lines (
      journal_entry_id,
      organization_id,
      business_id,
      branch_id,
      account_id,
      debit,
      credit,
      description,
      contact_id,
      analytic_account_id,
      exchange_rate
    ) VALUES (
      v_entry_id,
      _org_id,
      _business_id,
      _branch_id,
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

COMMENT ON FUNCTION public.post_journal_entry_atomic(uuid, uuid, text, date, text, text, text, uuid, uuid, boolean, boolean, jsonb, text, numeric, text, uuid) IS
  'Atomic journal entry poster. Stamps organization_id, business_id, and branch_id on every journal_entry_lines insert so the parent-match and NOT NULL guards added by the journal hardening migration are satisfied. Used by stock adjustment / opening-stock postings, among others.';
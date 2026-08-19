-- P1: journal numbering becomes owned by the posting engine itself.
CREATE OR REPLACE FUNCTION public.post_journal_entry_atomic(_org_id uuid, _business_id uuid, _entry_number text, _entry_date date, _reference text, _description text, _source_type text, _source_id uuid, _created_by uuid, _is_closing boolean, _is_adjusting boolean, _lines jsonb, _currency text DEFAULT NULL::text, _exchange_rate numeric DEFAULT NULL::numeric, _source_subtype text DEFAULT NULL::text, _branch_id uuid DEFAULT NULL::uuid)
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
  v_existing_id  uuid;
  v_entry_number text := NULLIF(btrim(_entry_number), '');
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

  -- Numbering is owned here, by the one canonical engine. Callers may supply an
  -- explicit number (legacy/repair paths); otherwise the engine assigns one.
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
    created_by, is_closing_entry, is_adjusting_entry,
    status, total_debit, total_credit,
    currency, exchange_rate,
    posted_at, posted_by
  ) VALUES (
    _org_id, _business_id, _branch_id,
    v_entry_number, _entry_date, _reference, _description,
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

-- P2: retire the duplicate, org-scoped numbering engine. Every caller now lets
-- the posting engine number the entry (business-scoped, isolation-safe).
DO $do$
DECLARE
  v_fn text;
  v_def text;
  v_new text;
BEGIN
  FOR v_fn IN SELECT unnest(ARRAY[
    'pos_card_settlement_post_gl','repair_misposted_ar_invoices',
    'process_pos_cash_movement','approve_stock_adjustment_atomic',
    'backfill_missing_adjustment_je','complete_delivery_atomic',
    '_confirm_invoice_core','post_missing_invoice_journals'])
  LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_fn
     LIMIT 1;
    IF v_def IS NULL THEN
      RAISE EXCEPTION 'function % not found', v_fn;
    END IF;

    v_new := regexp_replace(v_def,
      'public\.get_next_journal_entry_number\s*\([^()]*\)', 'NULL::text', 'g');

    IF v_new LIKE '%get_next_journal_entry_number%' THEN
      RAISE EXCEPTION 'could not rewrite numbering call in %', v_fn;
    END IF;
    EXECUTE v_new;
  END LOOP;
END $do$;

DROP FUNCTION IF EXISTS public.get_next_journal_entry_number(uuid);

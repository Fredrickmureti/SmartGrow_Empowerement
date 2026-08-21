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
  _branch_id uuid;
  _final_entry_number text;
  _final_reversal_date date;
  _reversal_subtype text;
  _is_org_admin boolean;
  _has_business_access boolean;
  _total_debit numeric := 0;
  _total_credit numeric := 0;
BEGIN
  SELECT * INTO _original FROM journal_entries WHERE id = _entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal entry not found: %', _entry_id;
  END IF;

  PERFORM public.assert_can_void_je(_original.business_id, _user_id);

  IF _user_id IS NOT NULL AND _original.business_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = _user_id
        AND organization_id = _original.organization_id
        AND role IN ('super_admin','owner','admin')
    ) INTO _is_org_admin;

    IF NOT COALESCE(_is_org_admin, false) THEN
      SELECT EXISTS (
        SELECT 1 FROM public.user_business_access
        WHERE user_id = _user_id
          AND organization_id = _original.organization_id
          AND business_id = _original.business_id
      ) INTO _has_business_access;

      IF NOT COALESCE(_has_business_access, false) THEN
        RAISE EXCEPTION 'User % is not authorized to void journal entries for business % in organization %',
          _user_id, _original.business_id, _original.organization_id
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  IF _original.status = 'reversed' AND _original.reversed_by_id IS NOT NULL THEN
    RETURN _original.reversed_by_id;
  END IF;

  IF _original.status = 'voided' THEN
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
    ELSE _original.source_subtype || '_reversal'
  END;

  _org_id      := _original.organization_id;
  _business_id := _original.business_id;
  _branch_id   := _original.branch_id;

  _final_reversal_date := COALESCE(_reversal_date, CURRENT_DATE);

  IF _entry_number IS NOT NULL AND length(btrim(_entry_number)) > 0 THEN
    _final_entry_number := _entry_number;
  ELSE
    _final_entry_number := _original.entry_number || '-REV';
  END IF;

  SELECT COALESCE(SUM(credit), 0), COALESCE(SUM(debit), 0)
    INTO _total_debit, _total_credit
    FROM public.journal_entry_lines
   WHERE journal_entry_id = _original.id;

  PERFORM set_config('app.suppress_je_recompute', 'on', true);

  -- The reversal inherits the original's denomination and booking rate
  -- (ADR 0136): a reversal never re-resolves a rate, it mirrors the original.
  INSERT INTO public.journal_entries (
    id, organization_id, business_id, branch_id, entry_number,
    entry_date, description, reference,
    is_adjusting, is_closing, status,
    is_reversal, reversal_of_id, source_type, source_subtype, source_id,
    total_debit, total_credit,
    currency, exchange_rate,
    created_by, created_at, updated_at,
    posted_at, posted_by_id
  ) VALUES (
    _reversal_id, _org_id, _business_id, _branch_id, _final_entry_number,
    _final_reversal_date,
    'Reversal of ' || _original.entry_number || ': ' || _reason,
    _original.reference,
    false, false, 'posted',
    true, _original.id,
    COALESCE(_original.source_type, 'manual'),
    _reversal_subtype,
    _original.source_id,
    _total_debit, _total_credit,
    _original.currency, _original.exchange_rate,
    COALESCE(_user_id, _original.created_by), _now, _now,
    _now, COALESCE(_user_id, _original.created_by)
  );

  FOR _line IN
    SELECT * FROM public.journal_entry_lines
    WHERE journal_entry_id = _original.id
    ORDER BY sort_order NULLS LAST, id
  LOOP
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, account_id, description,
      debit, credit, contact_id, sort_order,
      organization_id, business_id, branch_id,
      analytic_account_id, project_id,
      original_currency, exchange_rate,
      original_debit, original_credit
    ) VALUES (
      _reversal_id, _line.account_id,
      'Reversal: ' || COALESCE(_line.description, ''),
      _line.credit, _line.debit, _line.contact_id, _line.sort_order,
      _org_id, _business_id, _branch_id,
      _line.analytic_account_id, _line.project_id,
      _line.original_currency, _line.exchange_rate,
      _line.original_credit, _line.original_debit
    );
  END LOOP;

  PERFORM set_config('app.suppress_je_recompute', 'off', true);

  UPDATE public.journal_entries
     SET status = 'reversed',
         reversed_at = _now,
         reversed_by_id = COALESCE(_user_id, created_by),
         reversed_reason = _reason,
         updated_at = _now
   WHERE id = _original.id;

  RETURN _reversal_id;
END;
$function$;
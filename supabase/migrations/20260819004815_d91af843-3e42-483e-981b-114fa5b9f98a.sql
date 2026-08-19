-- P1b: the posting engine owns the opening-entry classification too.
-- Banking used to post the entry and then UPDATE journal_entries.is_opening_entry,
-- which the immutability trigger (correctly) refuses on a posted entry.
DROP FUNCTION IF EXISTS public.post_journal_entry_atomic(uuid,uuid,text,date,text,text,text,uuid,uuid,boolean,boolean,jsonb,text,numeric,text,uuid);

CREATE FUNCTION public.post_journal_entry_atomic(
  _org_id uuid, _business_id uuid, _entry_number text, _entry_date date,
  _reference text, _description text, _source_type text, _source_id uuid,
  _created_by uuid, _is_closing boolean, _is_adjusting boolean, _lines jsonb,
  _currency text DEFAULT NULL::text, _exchange_rate numeric DEFAULT NULL::numeric,
  _source_subtype text DEFAULT NULL::text, _branch_id uuid DEFAULT NULL::uuid,
  _is_opening_entry boolean DEFAULT false)
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

REVOKE ALL ON FUNCTION public.post_journal_entry_atomic(uuid,uuid,text,date,text,text,text,uuid,uuid,boolean,boolean,jsonb,text,numeric,text,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_journal_entry_atomic(uuid,uuid,text,date,text,text,text,uuid,uuid,boolean,boolean,jsonb,text,numeric,text,uuid,boolean) TO authenticated, service_role;

-- Banking: classify at insert time, never mutate a posted entry.
CREATE OR REPLACE FUNCTION public._bank_account_post_opening_balance(_account_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  a record;
  v_equity uuid;
  v_je uuid;
  v_amount numeric;
  v_base text;
  v_date date;
  v_rate numeric;
BEGIN
  SELECT * INTO a FROM public.bank_accounts WHERE id = _account_id FOR UPDATE;
  IF a.id IS NULL THEN
    RAISE EXCEPTION 'Bank account % not found', _account_id USING ERRCODE = 'no_data_found';
  END IF;
  IF a.opening_balance_je_id IS NOT NULL THEN
    RETURN a.opening_balance_je_id;              -- idempotent
  END IF;

  v_amount := COALESCE(a.opening_balance, 0);
  IF v_amount = 0 THEN RETURN NULL; END IF;

  IF a.account_id IS NULL THEN
    RAISE EXCEPTION 'Bank account "%" needs a Chart-of-Accounts link before its opening balance can be posted.', a.name
      USING ERRCODE = 'check_violation', HINT = 'BANK_OPENING_BALANCE_NEEDS_GL';
  END IF;

  v_equity := public.ensure_opening_balance_equity_account(a.organization_id, a.business_id);
  v_date   := COALESCE(a.opening_balance_date, CURRENT_DATE);

  SELECT base_currency INTO v_base FROM public.businesses WHERE id = a.business_id;

  IF a.currency IS NOT NULL AND v_base IS NOT NULL
     AND upper(a.currency) <> upper(v_base) THEN
    v_rate := public.require_exchange_rate(a.organization_id, a.business_id, a.currency, v_date);
  END IF;

  v_je := public.post_journal_entry_atomic(
    a.organization_id,
    a.business_id,
    NULL,
    v_date,
    'OB-BANK-' || LEFT(a.id::text, 8),
    'Opening balance - ' || a.name,
    'opening_balance',
    a.id,
    auth.uid(),
    false,
    false,
    jsonb_build_array(
      jsonb_build_object('account_id', a.account_id,
        'debit',  CASE WHEN v_amount > 0 THEN v_amount ELSE 0 END,
        'credit', CASE WHEN v_amount < 0 THEN -v_amount ELSE 0 END,
        'description', 'Opening balance - ' || a.name),
      jsonb_build_object('account_id', v_equity,
        'debit',  CASE WHEN v_amount < 0 THEN -v_amount ELSE 0 END,
        'credit', CASE WHEN v_amount > 0 THEN v_amount ELSE 0 END,
        'description', 'Opening balance - ' || a.name)
    ),
    a.currency,
    v_rate,
    'main',
    a.branch_id,
    true
  );

  UPDATE public.bank_accounts SET opening_balance_je_id = v_je WHERE id = _account_id;

  PERFORM public.publish_business_event(
    a.organization_id, a.branch_id, NULL,
    'banking.account.opening_balance_posted', 'bank_account', a.id,
    jsonb_build_object('business_id', a.business_id, 'amount', v_amount,
                       'currency', a.currency, 'journal_entry_id', v_je,
                       'exchange_rate', v_rate),
    'bank-ob-' || a.id::text, auth.uid());

  RETURN v_je;
END;
$function$;

REVOKE ALL ON FUNCTION public._bank_account_post_opening_balance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._bank_account_post_opening_balance(uuid) TO authenticated, service_role;
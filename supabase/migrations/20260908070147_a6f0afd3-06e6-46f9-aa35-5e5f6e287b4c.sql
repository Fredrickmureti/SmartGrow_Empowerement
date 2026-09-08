CREATE OR REPLACE FUNCTION public.mf_bank_collection_batch(p_batch_id uuid, p_bank_account_id uuid, p_banked_on date DEFAULT NULL::date, p_reference text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  b            public.mf_repayment_batches%ROWTYPE;
  ba           public.bank_accounts%ROWTYPE;
  v_org        uuid;
  v_cash       numeric := 0;
  v_mm         numeric := 0;
  v_total      numeric := 0;
  v_lines      jsonb := '[]'::jsonb;
  v_desc       text;
  v_date       date;
  v_je         uuid;
  v_id         uuid;
  v_currency   text;
BEGIN
  SELECT * INTO b FROM public.mf_repayment_batches WHERE id = p_batch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Collection batch % not found', p_batch_id; END IF;
  IF b.status <> 'closed' THEN
    RAISE EXCEPTION 'Batch % must be closed before it can be banked', b.batch_number;
  END IF;
  IF EXISTS (SELECT 1 FROM public.mf_collection_bankings WHERE batch_id = p_batch_id) THEN
    RAISE EXCEPTION 'Batch % has already been banked', b.batch_number;
  END IF;

  SELECT * INTO ba FROM public.bank_accounts WHERE id = p_bank_account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank account % not found', p_bank_account_id; END IF;
  IF ba.business_id IS DISTINCT FROM b.business_id THEN
    RAISE EXCEPTION 'Bank account does not belong to this institution';
  END IF;
  IF ba.account_id IS NULL THEN
    RAISE EXCEPTION 'Bank account % has no general ledger account configured', ba.name;
  END IF;

  SELECT
    COALESCE(SUM(CASE WHEN r.method = 'cash' THEN r.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN r.method = 'mobile_money' THEN r.amount ELSE 0 END), 0)
  INTO v_cash, v_mm
  FROM public.mf_repayments r
  WHERE r.batch_id = p_batch_id AND r.status = 'posted';

  v_total := v_cash + v_mm;
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'Batch % has no bankable cash or mobile-money receipts', b.batch_number;
  END IF;

  SELECT organization_id INTO v_org FROM public.businesses WHERE id = b.business_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Institution % has no organization', b.business_id; END IF;

  v_date := COALESCE(p_banked_on, b.collected_on, CURRENT_DATE);
  v_desc := format('Banking of collection batch %s', b.batch_number);
  v_currency := COALESCE(ba.currency, 'KES');

  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', ba.account_id, 'debit', v_total, 'credit', 0,
                       'description', v_desc));
  IF v_cash > 0 THEN
    v_lines := v_lines || jsonb_build_object(
      'account_id', public.mf_resolve_account(b.business_id, b.branch_id, 'cash'),
      'debit', 0, 'credit', v_cash, 'description', v_desc || ' - cash');
  END IF;
  IF v_mm > 0 THEN
    v_lines := v_lines || jsonb_build_object(
      'account_id', public.mf_resolve_account(b.business_id, b.branch_id, 'mobile_money'),
      'debit', 0, 'credit', v_mm, 'description', v_desc || ' - mobile money');
  END IF;

  v_id := gen_random_uuid();

  v_je := public.post_journal_entry_atomic(
    _org_id         => v_org,
    _business_id    => b.business_id,
    _entry_number   => NULL,
    _entry_date     => v_date,
    _reference      => COALESCE(p_reference, b.batch_number),
    _description    => v_desc,
    _source_type    => 'mf_collection_banking',
    _source_id      => v_id,
    _created_by     => auth.uid(),
    _is_closing     => false,
    _is_adjusting   => false,
    _lines          => v_lines,
    _currency       => v_currency,
    _exchange_rate  => NULL,
    _source_subtype => 'collection_banking',
    _branch_id      => b.branch_id);

  -- ADR: `bank_transactions` is the STATEMENT side of reconciliation — only what
  -- the bank reports belongs there (statement import / feed / manual entry). The
  -- banking of a collection batch is the BOOK side: it posts the journal entry
  -- above and records the banking below, then waits for the bank to confirm it.
  -- `bank_match_candidates` offers this banking as a match candidate when the
  -- real deposit arrives on the statement.
  INSERT INTO public.mf_collection_bankings (
    id, business_id, branch_id, batch_id, bank_account_id, banked_on, amount,
    cash_amount, mobile_money_amount, reference, notes, journal_entry_id,
    bank_transaction_id, banked_by
  ) VALUES (
    v_id, b.business_id, b.branch_id, p_batch_id, p_bank_account_id, v_date, v_total,
    v_cash, v_mm, p_reference, p_notes, v_je, NULL, auth.uid()
  );

  RETURN v_id;
END;
$function$;
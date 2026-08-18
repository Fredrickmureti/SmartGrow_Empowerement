CREATE OR REPLACE FUNCTION public.bank_statement_import_batch(_bank_account_id uuid, _rows jsonb, _statement jsonb DEFAULT NULL::jsonb, _source text DEFAULT 'manual_import'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  a              record;
  v_statement_id uuid;
  v_actor        uuid := auth.uid();
  v_row          jsonb;
  v_idx          int := 0;
  v_inserted     int := 0;
  v_duplicates   int := 0;
  v_rejected     int := 0;
  v_rejects      jsonb := '[]'::jsonb;
  v_date         date;
  v_amount       numeric;
  v_type         text;
  v_fp           text;
  v_rules        jsonb;
  v_category     text;
  v_conf         numeric;
  v_min_date     date;
  v_max_date     date;
  v_credits      numeric := 0;
  v_debits       numeric := 0;
  v_new_id       uuid;
  v_acct_ccy     text;
  v_row_ccy      text;
BEGIN
  IF _rows IS NULL OR jsonb_typeof(_rows) <> 'array' THEN
    RAISE EXCEPTION 'Import rows must be a JSON array'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'BANK_IMPORT_BAD_PAYLOAD';
  END IF;

  SELECT * INTO a FROM public.bank_accounts WHERE id = _bank_account_id FOR SHARE;
  IF a.id IS NULL THEN
    RAISE EXCEPTION 'Bank account % not found', _bank_account_id
      USING ERRCODE = 'no_data_found', HINT = 'BANK_ACCOUNT_NOT_FOUND';
  END IF;

  IF v_actor IS NOT NULL THEN
    PERFORM public.assert_can_reconcile_bank(a.business_id);
  ELSIF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Bank statement ingestion requires an authenticated caller'
      USING ERRCODE = '42501', HINT = 'BANK_IMPORT_NO_ACTOR';
  END IF;

  IF a.lifecycle_status <> 'active' THEN
    RAISE EXCEPTION 'Bank account "%" is % — only active accounts can receive statement activity.',
      a.name, a.lifecycle_status
      USING ERRCODE = 'check_violation', HINT = 'BANK_ACCOUNT_NOT_ACTIVE';
  END IF;

  v_acct_ccy := upper(nullif(btrim(a.currency), ''));

  IF _statement IS NOT NULL AND _statement <> 'null'::jsonb THEN
    INSERT INTO public.bank_statements (
      organization_id, business_id, branch_id, bank_account_id,
      file_name, file_hash, file_format, imported_by, status,
      opening_balance, closing_balance, statement_date
    ) VALUES (
      a.organization_id, a.business_id, a.branch_id, a.id,
      COALESCE(_statement->>'file_name', _source),
      COALESCE(_statement->>'file_hash', _source || '_' || gen_random_uuid()::text),
      _statement->>'file_format',
      v_actor,
      'processing',
      NULLIF(_statement->>'opening_balance', '')::numeric,
      NULLIF(_statement->>'closing_balance', '')::numeric,
      NULLIF(_statement->>'statement_date', '')::date
    )
    ON CONFLICT (organization_id, bank_account_id, file_hash) DO UPDATE
      SET status = 'processing', updated_at = now()
    RETURNING id INTO v_statement_id;
  END IF;

  FOR v_row IN SELECT jsonb_array_elements(_rows) LOOP
    v_idx := v_idx + 1;

    BEGIN
      v_date := NULLIF(v_row->>'transaction_date', '')::date;
      v_amount := NULLIF(v_row->>'amount', '')::numeric;
    EXCEPTION WHEN others THEN
      v_date := NULL; v_amount := NULL;
    END;

    IF v_date IS NULL OR v_amount IS NULL OR COALESCE(btrim(v_row->>'description'), '') = '' THEN
      v_rejected := v_rejected + 1;
      v_rejects := v_rejects || jsonb_build_array(jsonb_build_object(
        'row', v_idx, 'reason', 'Missing or invalid date, amount or description'));
      CONTINUE;
    END IF;

    -- Currency integrity: a statement line stated in another currency is not
    -- this account's money. Absorbing it would value it 1:1 (ADR 0136).
    v_row_ccy := upper(nullif(btrim(COALESCE(v_row->>'currency', v_row->>'original_currency', '')), ''));
    IF v_row_ccy IS NOT NULL AND v_acct_ccy IS NOT NULL AND v_row_ccy <> v_acct_ccy THEN
      v_rejected := v_rejected + 1;
      v_rejects := v_rejects || jsonb_build_array(jsonb_build_object(
        'row', v_idx,
        'reason', 'Line currency ' || v_row_ccy || ' does not match account currency ' || v_acct_ccy));
      CONTINUE;
    END IF;

    IF public.is_period_locked(a.organization_id, a.business_id, v_date) THEN
      v_rejected := v_rejected + 1;
      v_rejects := v_rejects || jsonb_build_array(jsonb_build_object(
        'row', v_idx, 'reason', 'Accounting period is locked for ' || to_char(v_date, 'YYYY-MM-DD')));
      CONTINUE;
    END IF;

    v_type := CASE WHEN v_amount >= 0 THEN 'credit' ELSE 'debit' END;

    v_fp := NULLIF(btrim(COALESCE(v_row->>'external_transaction_id', '')), '');
    IF v_fp IS NULL THEN
      v_fp := public.bank_transaction_fingerprint(
        a.id, v_date, v_row->>'description', v_amount, v_row->>'reference');
    END IF;

    v_category := NULLIF(v_row->>'category', '');
    v_conf := NULLIF(v_row->>'category_confidence', '')::numeric;
    IF v_category IS NULL THEN
      v_rules := public.bank_transaction_apply_rules(
        a.organization_id, a.business_id, a.id,
        v_row->>'description', v_row->>'reference', v_amount, v_type);
      IF v_rules IS NOT NULL THEN
        v_category := v_rules->>'category';
        v_conf := (v_rules->>'confidence')::numeric;
      END IF;
    END IF;

    INSERT INTO public.bank_transactions (
      organization_id, business_id, branch_id, bank_account_id,
      external_transaction_id, transaction_date, posting_date,
      description, reference, amount, balance_after, transaction_type,
      category, category_confidence, is_reconciled, lifecycle_status,
      statement_id, import_row_number, raw_data,
      ai_suggested_category, ai_confidence, ai_reasoning, original_currency
    ) VALUES (
      a.organization_id, a.business_id, a.branch_id, a.id,
      v_fp, v_date, NULLIF(v_row->>'posting_date', '')::date,
      btrim(v_row->>'description'), NULLIF(btrim(COALESCE(v_row->>'reference','')), ''),
      v_amount, NULLIF(v_row->>'balance_after', '')::numeric, v_type,
      v_category, v_conf, false, 'for_review',
      v_statement_id, v_idx, COALESCE(v_row->'raw_data', v_row),
      NULLIF(v_row->>'ai_suggested_category', ''),
      NULLIF(v_row->>'ai_confidence', '')::numeric,
      NULLIF(v_row->>'ai_reasoning', ''),
      COALESCE(v_row_ccy, v_acct_ccy)
    )
    ON CONFLICT (bank_account_id, external_transaction_id) DO NOTHING
    RETURNING id INTO v_new_id;

    IF v_new_id IS NULL THEN
      v_duplicates := v_duplicates + 1;
    ELSE
      v_inserted := v_inserted + 1;
      v_min_date := LEAST(COALESCE(v_min_date, v_date), v_date);
      v_max_date := GREATEST(COALESCE(v_max_date, v_date), v_date);
      IF v_amount >= 0 THEN v_credits := v_credits + v_amount;
      ELSE v_debits := v_debits + (-v_amount); END IF;
    END IF;
    v_new_id := NULL;
  END LOOP;

  IF v_statement_id IS NOT NULL THEN
    UPDATE public.bank_statements
       SET status = CASE WHEN v_rejected > 0 AND v_inserted = 0 THEN 'failed' ELSE 'completed' END,
           transaction_count = v_inserted,
           duplicate_count = v_duplicates,
           failed_count = v_rejected,
           total_credits = v_credits,
           total_debits = v_debits,
           period_start = COALESCE(v_min_date, period_start),
           period_end = COALESCE(v_max_date, period_end),
           updated_at = now()
     WHERE id = v_statement_id;
  END IF;

  PERFORM public.publish_business_event(
    a.organization_id, a.branch_id, NULL,
    'banking.statement.imported', 'bank_account', a.id,
    jsonb_build_object(
      'business_id', a.business_id,
      'bank_account_id', a.id,
      'statement_id', v_statement_id,
      'source', _source,
      'inserted', v_inserted,
      'duplicates', v_duplicates,
      'rejected', v_rejected,
      'period_start', v_min_date,
      'period_end', v_max_date),
    'bank-import-' || COALESCE(v_statement_id::text,
      a.id::text || '-' || v_inserted::text || '-' || extract(epoch from now())::bigint::text),
    v_actor);

  RETURN jsonb_build_object(
    'statement_id', v_statement_id,
    'inserted', v_inserted,
    'duplicates', v_duplicates,
    'rejected', v_rejected,
    'rejected_rows', v_rejects
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.reconcile_bank_transfer_atomic(_source_txn_id uuid, _dest_txn_id uuid DEFAULT NULL::uuid, _dest_bank_account_id uuid DEFAULT NULL::uuid, _user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _source_txn record;
  _dest_txn record;
  _source_gl uuid;
  _dest_gl uuid;
  _je_id uuid;
  _org_id uuid;
  _biz_id uuid;
  _abs_amount numeric;
  _src_ccy text;
  _dst_ccy text;
  _dest_acct uuid;
BEGIN
  SELECT * INTO _source_txn FROM bank_transactions WHERE id = _source_txn_id FOR UPDATE;
  IF _source_txn IS NULL THEN RAISE EXCEPTION 'Source transaction not found'; END IF;
  IF _source_txn.is_reconciled THEN RAISE EXCEPTION 'Source transaction is already reconciled'; END IF;

  _org_id := _source_txn.organization_id;
  _biz_id := _source_txn.business_id;
  _abs_amount := abs(_source_txn.amount);

  SELECT account_id, upper(nullif(btrim(currency), ''))
    INTO _source_gl, _src_ccy
    FROM bank_accounts WHERE id = _source_txn.bank_account_id;
  IF _source_gl IS NULL THEN RAISE EXCEPTION 'Source bank account has no GL account linked'; END IF;

  IF _dest_txn_id IS NOT NULL THEN
    SELECT * INTO _dest_txn FROM bank_transactions WHERE id = _dest_txn_id FOR UPDATE;
    IF _dest_txn IS NULL THEN RAISE EXCEPTION 'Destination transaction not found'; END IF;
    IF _dest_txn.is_reconciled THEN RAISE EXCEPTION 'Destination transaction already reconciled'; END IF;
    _dest_acct := _dest_txn.bank_account_id;
  ELSE
    _dest_acct := _dest_bank_account_id;
  END IF;

  IF _dest_acct IS NOT NULL THEN
    SELECT account_id, upper(nullif(btrim(currency), ''))
      INTO _dest_gl, _dst_ccy
      FROM bank_accounts WHERE id = _dest_acct;
  END IF;

  IF _dest_gl IS NULL THEN RAISE EXCEPTION 'Destination bank account has no GL account linked'; END IF;
  IF _source_gl = _dest_gl THEN RAISE EXCEPTION 'Source and destination cannot be the same GL account'; END IF;

  -- A cross-currency transfer cannot be booked as a 1:1 mirror; it needs an
  -- FX-aware entry with a resolved rate (ADR 0136).
  IF _src_ccy IS NOT NULL AND _dst_ccy IS NOT NULL AND _src_ccy <> _dst_ccy THEN
    RAISE EXCEPTION 'Cannot match a % transfer against a % account — cross-currency transfers require an FX entry.', _src_ccy, _dst_ccy
      USING ERRCODE = 'check_violation', HINT = 'BANK_TRANSFER_CURRENCY_MISMATCH';
  END IF;

  _je_id := public.post_journal_entry_atomic(
    _org_id, _biz_id,
    public.generate_next_je_number(_org_id, _biz_id),
    _source_txn.transaction_date,
    'BTRANSFER-' || substr(_source_txn_id::text, 1, 8),
    'Bank transfer',
    'bank_transfer', _source_txn_id, _user_id, false, false,
    CASE WHEN _source_txn.transaction_type = 'debit' THEN
      jsonb_build_array(
        jsonb_build_object('account_id', _dest_gl, 'debit', _abs_amount, 'credit', 0, 'description', 'Transfer in'),
        jsonb_build_object('account_id', _source_gl, 'debit', 0, 'credit', _abs_amount, 'description', 'Transfer out')
      )
    ELSE
      jsonb_build_array(
        jsonb_build_object('account_id', _source_gl, 'debit', _abs_amount, 'credit', 0, 'description', 'Transfer in'),
        jsonb_build_object('account_id', _dest_gl, 'debit', 0, 'credit', _abs_amount, 'description', 'Transfer out')
      )
    END,
    NULL, NULL, NULL, _source_txn.branch_id
  );

  UPDATE bank_transactions SET
    is_reconciled = true, reconciled_type = 'transfer',
    reconciled_entity_id = coalesce(_dest_txn_id::text, _dest_bank_account_id::text),
    reconciled_at = now(), reconciled_by = _user_id::text, journal_entry_id = _je_id
  WHERE id = _source_txn_id;

  IF _dest_txn_id IS NOT NULL THEN
    UPDATE bank_transactions SET
      is_reconciled = true, reconciled_type = 'transfer',
      reconciled_entity_id = _source_txn_id::text,
      reconciled_at = now(), reconciled_by = _user_id::text, journal_entry_id = _je_id
    WHERE id = _dest_txn_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'journal_entry_id', _je_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.bank_statement_import_batch(uuid, jsonb, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reconcile_bank_transfer_atomic(uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_statement_import_batch(uuid, jsonb, jsonb, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_bank_transfer_atomic(uuid, uuid, uuid, uuid) TO authenticated, service_role;
-- ============================================================
-- Banking Phase 3 — statement ingestion convergence
-- ============================================================

-- 1. Canonical row fingerprint (single dedup authority).
CREATE OR REPLACE FUNCTION public.bank_transaction_fingerprint(
  _bank_account_id uuid,
  _txn_date date,
  _description text,
  _amount numeric,
  _reference text
) RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  raw   text;
  h1    bigint := 2166136261;
  h2    bigint := 16777619;
  i     int;
  c     int;
  m     bigint := 4294967296;
BEGIN
  raw := _bank_account_id::text
      || '|' || to_char(_txn_date, 'YYYY-MM-DD')
      || '|' || btrim(COALESCE(_description, ''))
      || '|' || to_char(COALESCE(_amount, 0), 'FM999999999999990.00')
      || '|' || btrim(COALESCE(_reference, ''));

  FOR i IN 1 .. length(raw) LOOP
    c  := ascii(substr(raw, i, 1));
    h1 := ((h1 # c) * 16777619) % m;
    h2 := ((h2 # c) * 2166136261) % m;
  END LOOP;

  RETURN 'imp_' || lpad(to_hex(h1), 8, '0') || lpad(to_hex(h2), 8, '0');
END;
$$;

-- 2. Canonical server-side categorisation.
CREATE OR REPLACE FUNCTION public.bank_transaction_apply_rules(
  _organization_id uuid,
  _business_id uuid,
  _bank_account_id uuid,
  _description text,
  _reference text,
  _amount numeric,
  _transaction_type text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  r        record;
  abs_amt  numeric := abs(COALESCE(_amount, 0));
  matched  boolean;
  pat      text;
BEGIN
  FOR r IN
    SELECT *
    FROM public.transaction_categorization_rules
    WHERE organization_id = _organization_id
      AND business_id = _business_id
      AND COALESCE(is_active, true)
      AND (bank_account_id IS NULL OR bank_account_id = _bank_account_id)
    ORDER BY COALESCE(priority, 0) DESC, created_at DESC
  LOOP
    IF r.transaction_type IS NOT NULL
       AND r.transaction_type <> 'both'
       AND r.transaction_type <> _transaction_type THEN
      CONTINUE;
    END IF;
    IF r.min_amount IS NOT NULL AND abs_amt < r.min_amount THEN CONTINUE; END IF;
    IF r.max_amount IS NOT NULL AND abs_amt > r.max_amount THEN CONTINUE; END IF;

    IF r.description_pattern IS NOT NULL AND btrim(r.description_pattern) <> '' THEN
      IF COALESCE(r.use_regex, false) THEN
        BEGIN
          matched := COALESCE(_description, '') ~* r.description_pattern;
        EXCEPTION WHEN others THEN
          matched := false;
        END;
      ELSE
        matched := false;
        FOREACH pat IN ARRAY string_to_array(r.description_pattern, '|') LOOP
          IF btrim(pat) <> ''
             AND position(lower(btrim(pat)) IN lower(COALESCE(_description, ''))) > 0 THEN
            matched := true;
          END IF;
        END LOOP;
      END IF;
      IF NOT matched THEN CONTINUE; END IF;
    END IF;

    IF r.reference_pattern IS NOT NULL AND btrim(r.reference_pattern) <> '' THEN
      matched := false;
      FOREACH pat IN ARRAY string_to_array(r.reference_pattern, '|') LOOP
        IF btrim(pat) <> ''
           AND position(lower(btrim(pat)) IN lower(COALESCE(_reference, ''))) > 0 THEN
          matched := true;
        END IF;
      END LOOP;
      IF NOT matched THEN CONTINUE; END IF;
    END IF;

    RETURN jsonb_build_object(
      'category', r.target_category,
      'confidence', 1.0,
      'rule_id', r.id,
      'rule_name', r.rule_name
    );
  END LOOP;

  RETURN NULL;
END;
$$;

-- 3. THE ingestion engine.
CREATE OR REPLACE FUNCTION public.bank_statement_import_batch(
  _bank_account_id uuid,
  _rows jsonb,
  _statement jsonb DEFAULT NULL,
  _source text DEFAULT 'manual_import'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  PERFORM public.assert_can_reconcile_bank(a.business_id);

  IF a.lifecycle_status <> 'active' THEN
    RAISE EXCEPTION 'Bank account "%" is % — only active accounts can receive statement activity.',
      a.name, a.lifecycle_status
      USING ERRCODE = 'check_violation', HINT = 'BANK_ACCOUNT_NOT_ACTIVE';
  END IF;

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
      ai_suggested_category, ai_confidence, ai_reasoning
    ) VALUES (
      a.organization_id, a.business_id, a.branch_id, a.id,
      v_fp, v_date, NULLIF(v_row->>'posting_date', '')::date,
      btrim(v_row->>'description'), NULLIF(btrim(COALESCE(v_row->>'reference','')), ''),
      v_amount, NULLIF(v_row->>'balance_after', '')::numeric, v_type,
      v_category, v_conf, false, 'for_review',
      v_statement_id, v_idx, COALESCE(v_row->'raw_data', v_row),
      NULLIF(v_row->>'ai_suggested_category', ''),
      NULLIF(v_row->>'ai_confidence', '')::numeric,
      NULLIF(v_row->>'ai_reasoning', '')
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
$$;

-- 4. Register the ingestion topic.
INSERT INTO public.business_event_topics (topic_prefix, producer_domain, description)
SELECT 'banking.statement', 'banking',
       'Bank statement ingestion (manual import and provider feeds)'
WHERE NOT EXISTS (
  SELECT 1 FROM public.business_event_topics WHERE topic_prefix = 'banking.statement');

-- 5. Close the write seam.
REVOKE INSERT, UPDATE, DELETE ON public.bank_transactions FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.bank_statements FROM authenticated;

-- D-A: anon must not hold any privilege on financial tables.
REVOKE ALL ON public.bank_accounts FROM anon;
REVOKE ALL ON public.bank_transactions FROM anon;
REVOKE ALL ON public.bank_statements FROM anon;

-- D-B: SECURITY DEFINER banking mutators must not be callable by PUBLIC/anon.
REVOKE ALL ON FUNCTION public.bank_account_create(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bank_account_update(uuid, integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bank_account_transition(uuid, bank_account_lifecycle_status, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bank_account_delete_draft(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bank_account_reset_opening_balances(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bank_account_create(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bank_account_update(uuid, integer, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bank_account_transition(uuid, bank_account_lifecycle_status, text, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bank_account_delete_draft(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bank_account_reset_opening_balances(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.bank_statement_import_batch(uuid, jsonb, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bank_statement_import_batch(uuid, jsonb, jsonb, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bank_transaction_fingerprint(uuid, date, text, numeric, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bank_transaction_apply_rules(uuid, uuid, uuid, text, text, numeric, text) TO authenticated, service_role;

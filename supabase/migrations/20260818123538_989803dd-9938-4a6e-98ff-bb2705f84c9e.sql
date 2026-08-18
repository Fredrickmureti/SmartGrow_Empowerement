-- Wave 2 Phase 12: one matching seam only.
--  * the rule engine proposes through the seam instead of writing matches
--  * suggestions are business-scoped (D-11)
--  * the legacy one-to-one RPC becomes a thin shim (D-9/D-12)

-- 1. Rule engine: propose (and, when the rule says auto-post, confirm) through the seam.
CREATE OR REPLACE FUNCTION public.apply_reconciliation_rules(
  _bank_account_id uuid,
  _user_id uuid DEFAULT NULL,
  _max_rows integer DEFAULT 200
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _ba record;
  _txn record;
  _rule record;
  _proposed jsonb;
  _matched_count integer := 0;
  _posted_count integer := 0;
  _processed integer := 0;
  _skipped jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO _ba FROM public.bank_accounts WHERE id = _bank_account_id;
  IF _ba.id IS NULL THEN
    RAISE EXCEPTION 'BANK_ACCOUNT_NOT_FOUND' USING ERRCODE = '22023';
  END IF;

  PERFORM public.assert_can_reconcile_bank(_ba.business_id);

  FOR _txn IN
    SELECT *
    FROM public.bank_transactions
    WHERE bank_account_id = _bank_account_id
      AND business_id = _ba.business_id
      AND COALESCE(is_reconciled, false) = false
    ORDER BY transaction_date
    LIMIT _max_rows
  LOOP
    _processed := _processed + 1;

    SELECT r.* INTO _rule
    FROM public.bank_reconciliation_rules r
    WHERE r.business_id = _ba.business_id
      AND r.is_active
      AND (r.bank_account_id IS NULL OR r.bank_account_id = _bank_account_id)
      AND (r.amount_min IS NULL OR ABS(_txn.amount) >= r.amount_min)
      AND (r.amount_max IS NULL OR ABS(_txn.amount) <= r.amount_max)
      AND (
        r.amount_sign = 'any'
        OR (r.amount_sign = 'debit'  AND _txn.amount > 0)
        OR (r.amount_sign = 'credit' AND _txn.amount < 0)
      )
      AND (r.description_pattern IS NULL OR COALESCE(_txn.description, '') ILIKE r.description_pattern)
      AND (r.description_regex IS NULL OR COALESCE(_txn.description, '') ~* r.description_regex)
      AND (r.reference_pattern IS NULL OR COALESCE(_txn.reference, '') ILIKE r.reference_pattern)
    ORDER BY r.priority ASC, r.created_at ASC
    LIMIT 1;

    CONTINUE WHEN _rule.id IS NULL;

    IF _rule.counterpart_account_id IS NULL THEN
      _skipped := _skipped || jsonb_build_object(
        'bank_transaction_id', _txn.id, 'rule_id', _rule.id, 'reason', 'RULE_HAS_NO_COUNTERPART_ACCOUNT');
      CONTINUE;
    END IF;

    _proposed := public.bank_match_propose(
      _txn_id := _txn.id,
      _allocations := jsonb_build_array(jsonb_build_object(
        'document_type', 'account',
        'document_id', _rule.counterpart_account_id,
        'amount', ABS(_txn.amount),
        'description', COALESCE(_rule.description_template, _txn.description, _rule.name)
      )),
      _fee_amount := 0,
      _match_type := 'rule',
      _rule_id := _rule.id,
      _notes := COALESCE(_rule.description_template, _rule.name),
      _user_id := _user_id
    );
    _matched_count := _matched_count + 1;

    UPDATE public.bank_transactions
       SET match_source = 'rule:' || _rule.name,
           match_confidence = CASE WHEN _rule.auto_post THEN 0.95 ELSE 0.80 END,
           updated_at = now()
     WHERE id = _txn.id;

    UPDATE public.bank_reconciliation_rules
       SET match_count = COALESCE(match_count, 0) + 1,
           last_matched_at = now()
     WHERE id = _rule.id;

    IF _rule.auto_post THEN
      BEGIN
        PERFORM public.bank_match_confirm(
          (_proposed->>'match_id')::uuid,
          _user_id,
          'brule:' || _txn.id::text
        );
        _posted_count := _posted_count + 1;
      EXCEPTION WHEN OTHERS THEN
        -- An auto-post that cannot post honestly stays a proposal a human sees.
        _skipped := _skipped || jsonb_build_object(
          'bank_transaction_id', _txn.id, 'rule_id', _rule.id, 'reason', SQLERRM);
      END;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'processed', _processed,
    'matched', _matched_count,
    'posted', _posted_count,
    'skipped', _skipped
  );
END;
$$;

-- 2. Suggestions become business-scoped.
DROP FUNCTION IF EXISTS public.get_reconciliation_match_suggestions(uuid, uuid, integer);

CREATE OR REPLACE FUNCTION public.get_reconciliation_match_suggestions(
  _org_id uuid,
  _business_id uuid,
  _bank_account_id uuid,
  _limit integer DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _bank_gl_account_id uuid;
  _result jsonb := '[]'::jsonb;
  _txn record;
  _match record;
BEGIN
  IF _business_id IS NULL THEN
    RAISE EXCEPTION 'BANK_SUGGESTIONS_BUSINESS_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT account_id INTO _bank_gl_account_id
  FROM public.bank_accounts
  WHERE id = _bank_account_id
    AND organization_id = _org_id
    AND business_id = _business_id;

  IF _bank_gl_account_id IS NULL THEN
    RETURN _result;
  END IF;

  FOR _txn IN
    SELECT bt.id, bt.amount, bt.transaction_date, bt.description,
           bt.reference, bt.transaction_type
    FROM public.bank_transactions bt
    WHERE bt.bank_account_id = _bank_account_id
      AND bt.organization_id = _org_id
      AND bt.business_id = _business_id
      AND bt.is_reconciled = false
    ORDER BY bt.transaction_date DESC
    LIMIT _limit
  LOOP
    FOR _match IN
      SELECT
        jel.id AS line_id,
        je.id AS journal_entry_id,
        je.entry_number,
        je.entry_date,
        je.description AS je_description,
        je.source_type,
        je.source_id,
        jel.debit,
        jel.credit,
        CASE
          WHEN ABS(
            CASE WHEN _txn.transaction_type = 'credit' THEN jel.debit ELSE jel.credit END
            - ABS(_txn.amount)
          ) < 0.01 THEN 50
          ELSE 0
        END +
        CASE
          WHEN ABS(je.entry_date - _txn.transaction_date) = 0 THEN 30
          WHEN ABS(je.entry_date - _txn.transaction_date) <= 3 THEN 20
          WHEN ABS(je.entry_date - _txn.transaction_date) <= 7 THEN 10
          ELSE 0
        END +
        CASE
          WHEN _txn.reference IS NOT NULL AND _txn.reference <> ''
               AND je.reference ILIKE '%' || _txn.reference || '%' THEN 20
          ELSE 0
        END AS match_score
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      WHERE jel.account_id = _bank_gl_account_id
        AND je.organization_id = _org_id
        AND je.business_id = _business_id
        AND je.status = 'posted'
        AND (
          (_txn.transaction_type = 'credit' AND jel.debit > 0)
          OR (_txn.transaction_type = 'debit' AND jel.credit > 0)
        )
        AND ABS(
          CASE WHEN _txn.transaction_type = 'credit' THEN jel.debit ELSE jel.credit END
          - ABS(_txn.amount)
        ) < ABS(_txn.amount) * 0.01 + 0.01
        AND ABS(je.entry_date - _txn.transaction_date) <= 30
        AND NOT EXISTS (
          SELECT 1 FROM public.bank_transactions bt2
          WHERE bt2.matched_journal_entry_id = je.id
            AND bt2.is_reconciled = true
        )
      ORDER BY match_score DESC
      LIMIT 3
    LOOP
      IF _match.match_score >= 50 THEN
        _result := _result || jsonb_build_object(
          'bank_transaction_id', _txn.id,
          'bank_amount', _txn.amount,
          'bank_date', _txn.transaction_date,
          'bank_description', _txn.description,
          'journal_entry_id', _match.journal_entry_id,
          'entry_number', _match.entry_number,
          'entry_date', _match.entry_date,
          'je_description', _match.je_description,
          'source_type', _match.source_type,
          'source_id', _match.source_id,
          'gl_amount', CASE WHEN _txn.transaction_type = 'credit' THEN _match.debit ELSE _match.credit END,
          'match_score', _match.match_score,
          'line_id', _match.line_id
        );
      END IF;
    END LOOP;
  END LOOP;

  RETURN _result;
END;
$$;

-- 3. The legacy one-to-one RPC becomes a shim over the seam. No second engine.
CREATE OR REPLACE FUNCTION public.reconcile_bank_transaction_atomic(
  _txn_id uuid,
  _recon_type text,
  _entity_id uuid DEFAULT NULL,
  _category text DEFAULT NULL,
  _offset_account_id uuid DEFAULT NULL,
  _create_gl boolean DEFAULT true,
  _user_id uuid DEFAULT NULL,
  _client_request_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _txn public.bank_transactions;
  _doc_type text;
  _doc_id uuid;
  _proposed jsonb;
BEGIN
  IF NOT COALESCE(_create_gl, true) THEN
    RAISE EXCEPTION 'BANK_MATCH_GL_IS_NOT_OPTIONAL' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO _txn FROM public.bank_transactions WHERE id = _txn_id;
  IF _txn.id IS NULL THEN
    RAISE EXCEPTION 'BANK_MATCH_TXN_NOT_FOUND' USING ERRCODE = '22023';
  END IF;

  IF _recon_type IN ('invoice','bill') THEN
    IF _entity_id IS NULL THEN
      RAISE EXCEPTION 'BANK_MATCH_DOCUMENT_REQUIRED' USING ERRCODE = '22023';
    END IF;
    _doc_type := _recon_type;
    _doc_id := _entity_id;
  ELSIF _recon_type IN ('expense','transfer','manual') THEN
    IF _offset_account_id IS NULL THEN
      RAISE EXCEPTION 'BANK_MATCH_OFFSET_ACCOUNT_REQUIRED' USING ERRCODE = '22023';
    END IF;
    _doc_type := 'account';
    _doc_id := _offset_account_id;
  ELSE
    RAISE EXCEPTION 'BANK_MATCH_UNSUPPORTED_DOCUMENT_TYPE' USING ERRCODE = '22023';
  END IF;

  _proposed := public.bank_match_propose(
    _txn_id := _txn_id,
    _allocations := jsonb_build_array(jsonb_build_object(
      'document_type', _doc_type,
      'document_id', _doc_id,
      'amount', ABS(_txn.amount),
      'description', _category
    )),
    _fee_amount := 0,
    _match_type := 'manual',
    _rule_id := NULL,
    _notes := _category,
    _user_id := _user_id
  );

  RETURN public.bank_match_confirm(
    (_proposed->>'match_id')::uuid,
    _user_id,
    COALESCE(_client_request_id, 'brecon:' || _txn_id::text)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_reconciliation_match_suggestions(uuid, uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_reconciliation_match_suggestions(uuid, uuid, uuid, integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.apply_reconciliation_rules(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_reconciliation_rules(uuid, uuid, integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.reconcile_bank_transaction_atomic(uuid, text, uuid, text, uuid, boolean, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_bank_transaction_atomic(uuid, text, uuid, text, uuid, boolean, uuid, text) TO authenticated, service_role;
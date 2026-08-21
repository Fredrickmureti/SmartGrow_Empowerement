-- Phase 1 / CD-4 — apply_reconciliation_rules wrote a free-text match_source
-- ('rule:' || name), which bank_transactions_match_source_check
-- (manual | rule | ai) rejects with 23514, aborting the whole run on the first
-- rule match. The rule identity is already carried by
-- bank_reconciliation_matches.rule_id, so the vocabulary token is enough.
CREATE OR REPLACE FUNCTION public.apply_reconciliation_rules(_bank_account_id uuid, _user_id uuid DEFAULT NULL::uuid, _max_rows integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _ba record;
  _txn record;
  _rule record;
  _rival integer;
  _proposed jsonb;
  _cands jsonb;
  _tier text;
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
    SELECT t.*
    FROM public.bank_transactions t
    WHERE t.bank_account_id = _bank_account_id
      AND t.business_id = _ba.business_id
      AND COALESCE(t.is_reconciled, false) = false
      -- F16. A line that already carries a proposal is a decision waiting for
      -- a human; a second automated proposal is noise at best.
      AND NOT EXISTS (
        SELECT 1 FROM public.bank_reconciliation_matches m
         WHERE m.bank_transaction_id = t.id
           AND m.status IN ('proposed', 'confirmed')
      )
    ORDER BY t.transaction_date
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

    -- F16. Two rules of the same priority both claiming the line is an
    -- ambiguity, not a race to be won by creation order.
    SELECT count(*) INTO _rival
    FROM public.bank_reconciliation_rules r
    WHERE r.business_id = _ba.business_id
      AND r.is_active
      AND r.priority = _rule.priority
      AND r.counterpart_account_id IS DISTINCT FROM _rule.counterpart_account_id
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
      AND (r.reference_pattern IS NULL OR COALESCE(_txn.reference, '') ILIKE r.reference_pattern);

    IF _rival > 0 THEN
      _skipped := _skipped || jsonb_build_object(
        'bank_transaction_id', _txn.id, 'rule_id', _rule.id, 'reason', 'AMBIGUOUS_RULE_MATCH');
      CONTINUE;
    END IF;

    -- A rule may not categorise away a line that a real document or an
    -- already-recorded payment explains.
    _cands := public.bank_match_candidates(_txn.id, 5);
    _tier := _cands->>'tier';

    IF _tier IN ('settled', 'proposed') THEN
      _skipped := _skipped || jsonb_build_object(
        'bank_transaction_id', _txn.id, 'rule_id', _rule.id, 'reason', 'LINE_ALREADY_EXPLAINED');
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(_cands->'candidates') c
       WHERE c->>'kind' IN ('payment','bill_payment','invoice','bill','transfer')
    ) THEN
      _skipped := _skipped || jsonb_build_object(
        'bank_transaction_id', _txn.id, 'rule_id', _rule.id,
        'reason', 'DOCUMENT_CANDIDATE_EXISTS');
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

    -- CD-4. `match_source` is a vocabulary (manual | rule | ai), not a label.
    -- Which rule matched is recorded on bank_reconciliation_matches.rule_id.
    UPDATE public.bank_transactions
       SET match_source = 'rule',
           match_confidence = CASE WHEN _rule.auto_post THEN 0.95 ELSE 0.80 END,
           updated_at = now()
     WHERE id = _txn.id;

    UPDATE public.bank_reconciliation_rules
       SET match_count = COALESCE(match_count, 0) + 1,
           last_matched_at = now()
     WHERE id = _rule.id;

    -- Auto-post only what is unambiguous. An ambiguous line stays a proposal.
    IF _rule.auto_post AND _tier = 'ambiguous' THEN
      _skipped := _skipped || jsonb_build_object(
        'bank_transaction_id', _txn.id, 'rule_id', _rule.id, 'reason', 'AMBIGUOUS_NOT_AUTO_POSTED');
    ELSIF _rule.auto_post THEN
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
$function$;

REVOKE ALL ON FUNCTION public.apply_reconciliation_rules(uuid, uuid, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.apply_reconciliation_rules(uuid, uuid, integer) TO authenticated;
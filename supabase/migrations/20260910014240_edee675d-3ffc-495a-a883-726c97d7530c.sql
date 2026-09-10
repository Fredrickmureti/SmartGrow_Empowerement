CREATE OR REPLACE FUNCTION public.bank_match_candidates(_txn_id uuid, _limit integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _txn public.bank_transactions;
  _bank_ccy text;
  _inflow boolean;
  _abs numeric;
  _cands jsonb := '[]'::jsonb;
  _r record;
  _top numeric := 0;
  _top_count integer := 0;
  _tier text;
  _open record;
BEGIN
  SELECT * INTO _txn FROM public.bank_transactions WHERE id = _txn_id;
  IF _txn.id IS NULL THEN
    RAISE EXCEPTION 'BANK_MATCH_TXN_NOT_FOUND' USING ERRCODE = '22023';
  END IF;

  PERFORM public.assert_can_reconcile_bank(_txn.business_id);

  SELECT m.id, m.status INTO _open
    FROM public.bank_reconciliation_matches m
   WHERE m.bank_transaction_id = _txn_id
     AND m.status IN ('confirmed', 'suggested', 'to_check')
   ORDER BY CASE m.status WHEN 'confirmed' THEN 0 ELSE 1 END, m.created_at DESC
   LIMIT 1;

  IF _open.id IS NOT NULL OR COALESCE(_txn.is_reconciled, false) THEN
    RETURN jsonb_build_object(
      'bank_transaction_id', _txn_id,
      'tier', CASE WHEN _open.status <> 'confirmed' THEN 'proposed' ELSE 'settled' END,
      'existing_match_id', _open.id,
      'candidates', '[]'::jsonb,
      'reason', CASE WHEN _open.status <> 'confirmed'
                     THEN 'This line already has a proposed match awaiting confirmation.'
                     ELSE 'This line is already reconciled.' END
    );
  END IF;

  SELECT currency INTO _bank_ccy
    FROM public.bank_accounts WHERE id = _txn.bank_account_id;

  _inflow := COALESCE(_txn.transaction_type, CASE WHEN _txn.amount >= 0 THEN 'credit' ELSE 'debit' END) = 'credit';
  _abs := abs(_txn.amount);

  -- 1. A collection batch already banked into this account, awaiting the
  --    bank's confirmation. The banking entry is already posted, so this is
  --    linkage only — never a second settlement.
  IF _inflow THEN
    FOR _r IN
      SELECT cb.id, cb.amount, cb.banked_on, cb.reference,
             rb.batch_number,
             abs(cb.banked_on - _txn.transaction_date) AS day_gap,
             (COALESCE(_txn.reference,'') <> '' AND (
                COALESCE(cb.reference,'') ILIKE '%' || _txn.reference || '%'
                OR COALESCE(rb.batch_number,'') ILIKE '%' || _txn.reference || '%')) AS ref_hit,
             (rb.batch_number IS NOT NULL
                AND COALESCE(_txn.description,'') ILIKE '%' || rb.batch_number || '%') AS desc_hit
        FROM public.mf_collection_bankings cb
        LEFT JOIN public.mf_repayment_batches rb ON rb.id = cb.batch_id
       WHERE cb.business_id = _txn.business_id
         AND cb.bank_account_id = _txn.bank_account_id
         AND cb.bank_transaction_id IS NULL
         AND (cb.branch_id IS NULL OR _txn.branch_id IS NULL OR cb.branch_id = _txn.branch_id)
         AND abs(cb.amount - _abs) < 0.005
         AND cb.banked_on BETWEEN _txn.transaction_date - 14 AND _txn.transaction_date + 7
         AND NOT EXISTS (
           SELECT 1 FROM public.bank_reconciliation_matches m
            WHERE m.status IN ('suggested','to_check','confirmed')
              AND m.allocations @> jsonb_build_array(
                    jsonb_build_object('document_type','collection_banking','document_id', cb.id))
         )
       ORDER BY abs(cb.banked_on - _txn.transaction_date)
       LIMIT _limit
    LOOP
      _cands := _cands || jsonb_build_object(
        'kind', 'collection_banking',
        'label', 'Confirm the banked collection batch ' || COALESCE(_r.batch_number, ''),
        'effect', 'Already posted when the batch was banked — this only links the bank line, no new accounting.',
        'allocations', jsonb_build_array(jsonb_build_object(
          'document_type','collection_banking','document_id', _r.id, 'amount', _r.amount)),
        'evidence', jsonb_build_array('Exact amount', 'Banked into this bank account', 'Not yet confirmed by any bank line')
          || CASE WHEN _r.ref_hit OR _r.desc_hit THEN jsonb_build_array('Batch reference on the bank line') ELSE '[]'::jsonb END
          || CASE WHEN _r.day_gap = 0 THEN jsonb_build_array('Same date')
                  WHEN _r.day_gap <= 3 THEN jsonb_build_array('Within 3 days') ELSE '[]'::jsonb END,
        'score', 70 + (CASE WHEN _r.ref_hit OR _r.desc_hit THEN 20 ELSE 0 END)
                    + (CASE WHEN _r.day_gap = 0 THEN 10 WHEN _r.day_gap <= 3 THEN 5 ELSE 0 END)
      );
    END LOOP;
  END IF;

  -- 2. A loan already disbursed by bank, awaiting the bank's confirmation.
  IF NOT _inflow THEN
    FOR _r IN
      SELECT c AS cand FROM jsonb_array_elements(public.mf_bank_disbursement_candidates(_txn.id)) c
    LOOP
      _cands := _cands || jsonb_build_object(
        'kind', 'disbursement',
        'label', 'Confirm the ' || COALESCE(_r.cand->>'label', 'loan disbursement'),
        'effect', 'Already posted when the loan was disbursed - this only links the bank line, no new accounting.',
        'allocations', jsonb_build_array(jsonb_build_object(
          'document_type','disbursement','document_id', (_r.cand->>'document_id')::uuid,
          'amount', (_r.cand->>'amount')::numeric)),
        'evidence', jsonb_build_array('Exact amount', 'Paid out of this bank account', 'Not yet confirmed by any bank line'),
        'score', COALESCE((_r.cand->>'score')::numeric, 70)
      );
    END LOOP;
  END IF;

  -- 3. A transfer from one of our own accounts.
  FOR _r IN
    SELECT bt.id, ba.id AS account_id, ba.name AS account_name,
           abs(bt.transaction_date - _txn.transaction_date) AS day_gap
      FROM public.bank_transactions bt
      JOIN public.bank_accounts ba ON ba.id = bt.bank_account_id
     WHERE bt.business_id = _txn.business_id
       AND bt.bank_account_id <> _txn.bank_account_id
       AND COALESCE(bt.is_reconciled,false) = false
       AND abs(abs(bt.amount) - _abs) < 0.005
       AND COALESCE(ba.currency,'') = COALESCE(_bank_ccy,'')
       AND (COALESCE(bt.transaction_type, CASE WHEN bt.amount >= 0 THEN 'credit' ELSE 'debit' END))
           <> (CASE WHEN _inflow THEN 'credit' ELSE 'debit' END)
       AND bt.transaction_date BETWEEN _txn.transaction_date - 5 AND _txn.transaction_date + 5
       AND NOT EXISTS (
         SELECT 1 FROM public.bank_reconciliation_matches m
          WHERE m.bank_transaction_id = bt.id
            AND m.status IN ('proposed','confirmed')
       )
     ORDER BY abs(bt.transaction_date - _txn.transaction_date)
     LIMIT 3
  LOOP
    _cands := _cands || jsonb_build_object(
      'kind', 'transfer',
      'label', 'Transfer with ' || _r.account_name,
      'effect', 'Move money between two of your own bank accounts — no profit or loss',
      'allocations', jsonb_build_array(jsonb_build_object(
        'document_type','transfer','document_id', _r.account_id, 'amount', _abs,
        'mirror_transaction_id', _r.id)),
      'evidence', jsonb_build_array('Opposite movement of the same amount on another of your accounts',
                                    'Same currency')
        || CASE WHEN _r.day_gap = 0 THEN jsonb_build_array('Same date') ELSE '[]'::jsonb END,
      'score', 70 + CASE WHEN _r.day_gap = 0 THEN 10 ELSE 0 END
    );
  END LOOP;

  -- 4. A categorisation rule — the weakest evidence there is.
  IF jsonb_array_length(_cands) = 0 THEN
    FOR _r IN
      SELECT r.id, r.name, r.counterpart_account_id, r.description_template, a.name AS account_name
        FROM public.bank_reconciliation_rules r
        JOIN public.accounts a ON a.id = r.counterpart_account_id
       WHERE r.business_id = _txn.business_id
         AND r.is_active
         AND (r.bank_account_id IS NULL OR r.bank_account_id = _txn.bank_account_id)
         AND (r.branch_id IS NULL OR _txn.branch_id IS NULL OR r.branch_id = _txn.branch_id)
         AND (r.amount_min IS NULL OR _abs >= r.amount_min)
         AND (r.amount_max IS NULL OR _abs <= r.amount_max)
         AND (r.amount_sign = 'any'
              OR (r.amount_sign = 'debit'  AND _txn.amount > 0)
              OR (r.amount_sign = 'credit' AND _txn.amount < 0))
         AND (r.description_pattern IS NULL OR COALESCE(_txn.description,'') ILIKE r.description_pattern)
         AND (r.description_regex IS NULL OR COALESCE(_txn.description,'') ~* r.description_regex)
         AND (r.reference_pattern IS NULL OR COALESCE(_txn.reference,'') ILIKE r.reference_pattern)
       ORDER BY r.priority ASC, r.created_at ASC
       LIMIT 3
    LOOP
      _cands := _cands || jsonb_build_object(
        'kind', 'account',
        'label', 'Categorise as ' || _r.account_name,
        'rule_id', _r.id,
        'effect', 'Posts this bank movement against ' || _r.account_name,
        'allocations', jsonb_build_array(jsonb_build_object(
          'document_type','account','document_id', _r.counterpart_account_id, 'amount', _abs,
          'description', COALESCE(_r.description_template, _txn.description, _r.name))),
        'evidence', jsonb_build_array('Matches the rule "' || _r.name || '"',
                                      'No document explains this line'),
        'score', 30
      );
    END LOOP;
  END IF;

  SELECT COALESCE(max((c->>'score')::numeric), 0) INTO _top FROM jsonb_array_elements(_cands) c;
  SELECT count(*) INTO _top_count FROM jsonb_array_elements(_cands) c WHERE (c->>'score')::numeric = _top;

  IF jsonb_array_length(_cands) = 0 THEN
    _tier := 'unresolved';
  ELSIF _top_count > 1 THEN
    _tier := 'ambiguous';
  ELSIF _top >= 80 THEN
    _tier := 'deterministic';
  ELSIF _top >= 55 THEN
    _tier := 'suggested';
  ELSE
    _tier := 'weak';
  END IF;

  RETURN jsonb_build_object(
    'bank_transaction_id', _txn_id,
    'tier', _tier,
    'candidates', (
      SELECT COALESCE(jsonb_agg(c ORDER BY (c->>'score')::numeric DESC), '[]'::jsonb)
        FROM jsonb_array_elements(_cands) c
    )
  );
END;
$function$;
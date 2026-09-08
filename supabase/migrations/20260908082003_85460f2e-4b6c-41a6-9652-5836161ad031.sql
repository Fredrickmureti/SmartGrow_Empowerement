
DO $mig$
DECLARE
  _def text;
  _anchor text;
  _new text;
BEGIN
  ---------------------------------------------------------------- candidates
  SELECT pg_get_functiondef(p.oid) INTO _def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'bank_match_candidates';

  _anchor := '  -- 3. A transfer from one of our own accounts.';
  IF position(_anchor in _def) = 0 THEN
    RAISE EXCEPTION 'anchor missing in bank_match_candidates';
  END IF;

  _new := $r1$  -- 2b. A loan already disbursed by bank, awaiting the bank's confirmation.
  --      The disbursement posted its own entry, so this is linkage only.
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

$r1$ || _anchor;

  EXECUTE replace(_def, _anchor, _new);

  ---------------------------------------------------------------- validation
  SELECT pg_get_functiondef(p.oid) INTO _def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_bank_match_validate';

  _anchor := '    ELSIF _kind = ''payment'' THEN';
  IF position(_anchor in _def) = 0 THEN
    RAISE EXCEPTION 'anchor missing in _bank_match_validate';
  END IF;

  _new := $r2$    ELSIF _kind = 'disbursement' THEN
      -- A loan already disbursed. Its entry credited this bank account, so the
      -- statement line is the bank confirming it: linkage only.
      IF _inflow THEN
        RAISE EXCEPTION 'BANK_MATCH_DIRECTION_MISMATCH: a loan disbursement is confirmed by money out' USING ERRCODE = '22023';
      END IF;
      SELECT d.business_id, l.branch_id, COALESCE(d.net_amount, d.amount), d.bank_transaction_id
        INTO _biz, _branch, _pay_amount, _cb_link
        FROM public.mf_loan_disbursements d
        JOIN public.mf_loans l ON l.id = d.loan_id
       WHERE d.id = (_a->>'document_id')::uuid;
      IF _biz IS NULL THEN RAISE EXCEPTION 'BANK_MATCH_DOCUMENT_NOT_FOUND' USING ERRCODE = '22023'; END IF;
      IF _cb_link IS NOT NULL AND _cb_link IS DISTINCT FROM _txn.id THEN
        RAISE EXCEPTION 'BANK_MATCH_DISBURSEMENT_ALREADY_CONFIRMED' USING ERRCODE = '22023';
      END IF;
      IF abs(_amt - COALESCE(_pay_amount, 0)) > 0.005 THEN
        RAISE EXCEPTION 'BANK_MATCH_DISBURSEMENT_AMOUNT_MISMATCH: a disbursement is confirmed in full' USING ERRCODE = '22023';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.bank_reconciliation_matches m
         WHERE m.status = 'confirmed'
           AND m.bank_transaction_id IS DISTINCT FROM _txn.id
           AND m.allocations @> jsonb_build_array(jsonb_build_object('document_type','disbursement','document_id', _a->>'document_id'))
      ) THEN
        RAISE EXCEPTION 'BANK_MATCH_DISBURSEMENT_ALREADY_CONFIRMED' USING ERRCODE = '22023';
      END IF;
      IF COALESCE(_fee_amount, 0) > 0 THEN
        RAISE EXCEPTION 'BANK_MATCH_FEE_ON_DIRECT_PAYMENT: the disbursement already posted the full amount to this bank account - record the charge as its own bank line'
          USING ERRCODE = '22023';
      END IF;

$r2$ || _anchor;

  EXECUTE replace(_def, _anchor, _new);

  ---------------------------------------------------------------- confirm
  SELECT pg_get_functiondef(p.oid) INTO _def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'bank_match_confirm';

  _anchor := '  ELSIF _kind IN (''payment'',''bill_payment'') THEN';
  IF position(_anchor in _def) = 0 THEN
    RAISE EXCEPTION 'anchor missing in bank_match_confirm';
  END IF;

  _new := $r3$  ELSIF _kind = 'disbursement' THEN
    -- The loan disbursement posted its own entry when the money went out.
    -- This statement line is the bank confirming it: link, never post again.
    _cb_id := (_m.allocations->0->>'document_id')::uuid;
    _je_id := public.mf_disbursement_journal_entry(_cb_id);

    UPDATE public.mf_loan_disbursements
       SET bank_transaction_id = _txn.id, updated_at = now()
     WHERE id = _cb_id
       AND bank_transaction_id IS NULL;

$r3$ || _anchor;

  EXECUTE replace(_def, _anchor, _new);

  ---------------------------------------------------------------- preflight
  SELECT pg_get_functiondef(p.oid) INTO _def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'bank_unmatch_preflight';

  _anchor := '_link_only := COALESCE(_kind, '''') = ''collection_banking'';';
  IF position(_anchor in _def) = 0 THEN
    RAISE EXCEPTION 'anchor missing in bank_unmatch_preflight';
  END IF;
  _def := replace(_def, _anchor, '_link_only := COALESCE(_kind, '''') IN (''collection_banking'',''disbursement'');');
  _def := replace(_def,
    'WHEN _link_only THEN ''Un-matching will only unlink the banked collection batch;',
    'WHEN _link_only THEN ''Un-matching will only unlink the confirmed record;');
  EXECUTE _def;

  ---------------------------------------------------------------- unreconcile
  SELECT pg_get_functiondef(p.oid) INTO _def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'unreconcile_bank_transaction';

  _anchor := '_link_only := COALESCE(_txn.reconciled_type, '''') = ''collection_banking'';';
  IF position(_anchor in _def) = 0 THEN
    RAISE EXCEPTION 'anchor missing in unreconcile_bank_transaction';
  END IF;
  _def := replace(_def, _anchor,
    '_link_only := COALESCE(_txn.reconciled_type, '''') IN (''collection_banking'',''disbursement'');');

  _anchor := 'GET DIAGNOSTICS _cleared_bankings = ROW_COUNT;';
  IF position(_anchor in _def) = 0 THEN
    RAISE EXCEPTION 'anchor 2 missing in unreconcile_bank_transaction';
  END IF;
  _def := replace(_def, _anchor, $r4$GET DIAGNOSTICS _cleared_bankings = ROW_COUNT;

    UPDATE public.mf_loan_disbursements
       SET bank_transaction_id = NULL, updated_at = now()
     WHERE bank_transaction_id = _bank_transaction_id;$r4$);

  EXECUTE _def;
END;
$mig$;

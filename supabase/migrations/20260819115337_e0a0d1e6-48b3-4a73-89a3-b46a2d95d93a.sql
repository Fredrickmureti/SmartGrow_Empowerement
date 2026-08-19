-- ============================================================
-- Candidate / evidence engine
-- ============================================================

CREATE OR REPLACE FUNCTION public.bank_match_candidates(_txn_id uuid, _limit integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _txn public.bank_transactions;
  _bank_ccy text;
  _bank_gl uuid;
  _inflow boolean;
  _abs numeric;
  _cands jsonb := '[]'::jsonb;
  _r record;
  _top numeric := 0;
  _top_count integer := 0;
  _tier text;
BEGIN
  SELECT * INTO _txn FROM public.bank_transactions WHERE id = _txn_id;
  IF _txn.id IS NULL THEN
    RAISE EXCEPTION 'BANK_MATCH_TXN_NOT_FOUND' USING ERRCODE = '22023';
  END IF;

  PERFORM public.assert_can_reconcile_bank(_txn.business_id);

  SELECT currency, account_id INTO _bank_ccy, _bank_gl
    FROM public.bank_accounts WHERE id = _txn.bank_account_id;

  _inflow := COALESCE(_txn.transaction_type, CASE WHEN _txn.amount >= 0 THEN 'credit' ELSE 'debit' END) = 'credit';
  _abs := abs(_txn.amount);

  -- 1. An existing customer receipt awaiting deposit (money in).
  IF _inflow THEN
    FOR _r IN
      SELECT p.id, p.amount, p.payment_date, p.reference, p.receipt_number,
             c.name AS party, a.name AS holding_account,
             (p.deposit_account_id = _bank_gl) AS already_in_bank,
             (COALESCE(_txn.reference,'') <> '' AND (
                COALESCE(p.reference,'') ILIKE '%' || _txn.reference || '%'
                OR COALESCE(p.receipt_number,'') ILIKE '%' || _txn.reference || '%')) AS ref_hit,
             (c.name IS NOT NULL AND COALESCE(_txn.description,'') ILIKE '%' || c.name || '%') AS party_hit,
             abs(p.payment_date - _txn.transaction_date) AS day_gap
        FROM public.payments p
        LEFT JOIN public.contacts c ON c.id = p.contact_id
        LEFT JOIN public.accounts a ON a.id = p.deposit_account_id
       WHERE p.business_id = _txn.business_id
         AND COALESCE(p.status,'') NOT IN ('voided','cancelled')
         AND p.deposit_account_id IS NOT NULL
         AND (p.branch_id IS NULL OR _txn.branch_id IS NULL OR p.branch_id = _txn.branch_id)
         AND abs(p.amount - _abs) < 0.005
         AND p.payment_date BETWEEN _txn.transaction_date - 45 AND _txn.transaction_date + 7
         AND NOT EXISTS (
           SELECT 1 FROM public.bank_reconciliation_matches m
            WHERE m.status = 'confirmed'
              AND m.allocations @> jsonb_build_array(jsonb_build_object('document_type','payment','document_id', p.id::text))
         )
       ORDER BY abs(p.payment_date - _txn.transaction_date)
       LIMIT _limit
    LOOP
      _cands := _cands || jsonb_build_object(
        'kind', 'payment',
        'label', CASE WHEN _r.already_in_bank
                      THEN 'Link the recorded receipt from ' || COALESCE(_r.party,'this customer')
                      ELSE 'Deposit the recorded receipt from ' || COALESCE(_r.party,'this customer') END,
        'party', _r.party,
        'effect', CASE WHEN _r.already_in_bank
                       THEN 'Already posted to this bank account — no new accounting.'
                       ELSE 'Debit this bank account, credit ' || COALESCE(_r.holding_account,'the holding account') END,
        'allocations', jsonb_build_array(jsonb_build_object(
          'document_type','payment','document_id', _r.id, 'amount', _r.amount)),
        'evidence', (CASE WHEN true THEN jsonb_build_array('Exact amount') ELSE '[]'::jsonb END)
          || CASE WHEN _r.party_hit THEN jsonb_build_array('Customer named on the bank line') ELSE '[]'::jsonb END
          || CASE WHEN _r.ref_hit THEN jsonb_build_array('Reference matches the receipt') ELSE '[]'::jsonb END
          || CASE WHEN _r.day_gap = 0 THEN jsonb_build_array('Same date')
                  WHEN _r.day_gap <= 3 THEN jsonb_build_array('Within 3 days') ELSE '[]'::jsonb END
          || jsonb_build_array('Receipt is not yet deposited'),
        'score', 60 + (CASE WHEN _r.party_hit THEN 20 ELSE 0 END)
                    + (CASE WHEN _r.ref_hit THEN 20 ELSE 0 END)
                    + (CASE WHEN _r.day_gap = 0 THEN 10 WHEN _r.day_gap <= 3 THEN 5 ELSE 0 END)
      );
    END LOOP;

    -- 1b. Several recorded receipts banked as one deposit.
    FOR _r IN
      WITH pool AS (
        SELECT p.id, p.amount, p.contact_id
          FROM public.payments p
         WHERE p.business_id = _txn.business_id
           AND COALESCE(p.status,'') NOT IN ('voided','cancelled')
           AND p.deposit_account_id IS NOT NULL
           AND p.deposit_account_id <> _bank_gl
           AND (p.branch_id IS NULL OR _txn.branch_id IS NULL OR p.branch_id = _txn.branch_id)
           AND p.amount < _abs
           AND p.payment_date BETWEEN _txn.transaction_date - 30 AND _txn.transaction_date
           AND NOT EXISTS (
             SELECT 1 FROM public.bank_reconciliation_matches m
              WHERE m.status = 'confirmed'
                AND m.allocations @> jsonb_build_array(jsonb_build_object('document_type','payment','document_id', p.id::text))
           )
         ORDER BY p.payment_date DESC
         LIMIT 12
      )
      SELECT jsonb_agg(jsonb_build_object('document_type','payment','document_id', x.id, 'amount', x.amount)) AS allocs,
             count(*) AS n
        FROM (
          SELECT a.id, a.amount FROM pool a, pool b
           WHERE a.id < b.id AND abs(a.amount + b.amount - _abs) < 0.005
          UNION ALL
          SELECT b.id, b.amount FROM pool a, pool b
           WHERE a.id < b.id AND abs(a.amount + b.amount - _abs) < 0.005
        ) x
       HAVING count(*) = 2
    LOOP
      CONTINUE WHEN _r.allocs IS NULL;
      _cands := _cands || jsonb_build_object(
        'kind', 'payment',
        'label', 'Deposit ' || _r.n || ' recorded receipts banked together',
        'effect', 'Debit this bank account, credit the holding accounts of those receipts',
        'allocations', _r.allocs,
        'evidence', jsonb_build_array('The receipts add up to the deposit exactly', 'None of them is yet deposited'),
        'score', 55
      );
    END LOOP;

  ELSE
    -- 2. An existing supplier payment clearing the bank (money out).
    FOR _r IN
      SELECT bp.id, bp.amount, bp.payment_date, bp.reference,
             c.name AS party,
             abs(bp.payment_date - _txn.transaction_date) AS day_gap,
             (COALESCE(_txn.reference,'') <> '' AND COALESCE(bp.reference,'') ILIKE '%' || _txn.reference || '%') AS ref_hit,
             (c.name IS NOT NULL AND COALESCE(_txn.description,'') ILIKE '%' || c.name || '%') AS party_hit
        FROM public.bill_payments bp
        LEFT JOIN public.contacts c ON c.id = bp.vendor_id
       WHERE bp.business_id = _txn.business_id
         AND COALESCE(bp.status,'') NOT IN ('voided','cancelled')
         AND (bp.branch_id IS NULL OR _txn.branch_id IS NULL OR bp.branch_id = _txn.branch_id)
         AND abs(bp.amount - _abs) < 0.005
         AND bp.payment_date BETWEEN _txn.transaction_date - 45 AND _txn.transaction_date + 7
         AND NOT EXISTS (
           SELECT 1 FROM public.bank_reconciliation_matches m
            WHERE m.status = 'confirmed'
              AND m.allocations @> jsonb_build_array(jsonb_build_object('document_type','bill_payment','document_id', bp.id::text))
         )
       ORDER BY abs(bp.payment_date - _txn.transaction_date)
       LIMIT _limit
    LOOP
      _cands := _cands || jsonb_build_object(
        'kind', 'bill_payment',
        'label', 'Clear the recorded payment to ' || COALESCE(_r.party,'this supplier'),
        'party', _r.party,
        'effect', 'Credit this bank account against the payment''s holding account',
        'allocations', jsonb_build_array(jsonb_build_object(
          'document_type','bill_payment','document_id', _r.id, 'amount', _r.amount)),
        'evidence', jsonb_build_array('Exact amount')
          || CASE WHEN _r.party_hit THEN jsonb_build_array('Supplier named on the bank line') ELSE '[]'::jsonb END
          || CASE WHEN _r.ref_hit THEN jsonb_build_array('Reference matches the payment') ELSE '[]'::jsonb END
          || CASE WHEN _r.day_gap = 0 THEN jsonb_build_array('Same date') ELSE '[]'::jsonb END
          || jsonb_build_array('Payment is not yet cleared'),
        'score', 60 + (CASE WHEN _r.party_hit THEN 20 ELSE 0 END)
                    + (CASE WHEN _r.ref_hit THEN 20 ELSE 0 END)
                    + (CASE WHEN _r.day_gap = 0 THEN 10 WHEN _r.day_gap <= 3 THEN 5 ELSE 0 END)
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

  -- 4. An open document, when no receipt/payment was recorded at all.
  IF _inflow THEN
    FOR _r IN
      SELECT i.id, i.invoice_number, c.name AS party,
             GREATEST(COALESCE(i.total,0) - COALESCE(i.amount_paid,0), 0) AS open_amount,
             (c.name IS NOT NULL AND COALESCE(_txn.description,'') ILIKE '%' || c.name || '%') AS party_hit,
             (COALESCE(_txn.reference,'') <> '' AND COALESCE(i.invoice_number,'') ILIKE '%' || _txn.reference || '%') AS ref_hit
        FROM public.invoices i
        LEFT JOIN public.contacts c ON c.id = i.contact_id
       WHERE i.business_id = _txn.business_id
         AND COALESCE(i.status,'') NOT IN ('draft','cancelled','void','voided')
         AND (i.branch_id IS NULL OR _txn.branch_id IS NULL OR i.branch_id = _txn.branch_id)
         AND COALESCE(i.currency, _bank_ccy) = COALESCE(_bank_ccy, i.currency)
         AND abs(GREATEST(COALESCE(i.total,0) - COALESCE(i.amount_paid,0), 0) - _abs) < 0.005
       LIMIT _limit
    LOOP
      _cands := _cands || jsonb_build_object(
        'kind', 'invoice',
        'label', 'Record a receipt against ' || COALESCE(_r.invoice_number,'this invoice'),
        'party', _r.party,
        'effect', 'Creates a customer receipt: debit this bank account, credit Accounts Receivable',
        'allocations', jsonb_build_array(jsonb_build_object(
          'document_type','invoice','document_id', _r.id, 'amount', _r.open_amount)),
        'evidence', jsonb_build_array('Exact outstanding amount', 'No receipt has been recorded for it')
          || CASE WHEN _r.party_hit THEN jsonb_build_array('Customer named on the bank line') ELSE '[]'::jsonb END
          || CASE WHEN _r.ref_hit THEN jsonb_build_array('Invoice number on the bank line') ELSE '[]'::jsonb END,
        'score', 40 + (CASE WHEN _r.party_hit THEN 15 ELSE 0 END) + (CASE WHEN _r.ref_hit THEN 15 ELSE 0 END)
      );
    END LOOP;
  ELSE
    FOR _r IN
      SELECT b.id, b.bill_number, c.name AS party,
             GREATEST(COALESCE(b.total,0) - COALESCE(b.amount_paid,0), 0) AS open_amount,
             (c.name IS NOT NULL AND COALESCE(_txn.description,'') ILIKE '%' || c.name || '%') AS party_hit
        FROM public.bills b
        LEFT JOIN public.contacts c ON c.id = b.vendor_id
       WHERE b.business_id = _txn.business_id
         AND COALESCE(b.status,'') NOT IN ('draft','cancelled','void','voided')
         AND (b.branch_id IS NULL OR _txn.branch_id IS NULL OR b.branch_id = _txn.branch_id)
         AND COALESCE(b.currency, _bank_ccy) = COALESCE(_bank_ccy, b.currency)
         AND abs(GREATEST(COALESCE(b.total,0) - COALESCE(b.amount_paid,0), 0) - _abs) < 0.005
       LIMIT _limit
    LOOP
      _cands := _cands || jsonb_build_object(
        'kind', 'bill',
        'label', 'Record a payment against ' || COALESCE(_r.bill_number,'this bill'),
        'party', _r.party,
        'effect', 'Creates a supplier payment: debit Accounts Payable, credit this bank account',
        'allocations', jsonb_build_array(jsonb_build_object(
          'document_type','bill','document_id', _r.id, 'amount', _r.open_amount)),
        'evidence', jsonb_build_array('Exact outstanding amount', 'No payment has been recorded for it')
          || CASE WHEN _r.party_hit THEN jsonb_build_array('Supplier named on the bank line') ELSE '[]'::jsonb END,
        'score', 40 + CASE WHEN _r.party_hit THEN 15 ELSE 0 END
      );
    END LOOP;
  END IF;

  -- 5. A categorisation rule — the weakest evidence there is, and never a
  --    reason to skip a document that explains the line.
  IF jsonb_array_length(_cands) = 0 THEN
    FOR _r IN
      SELECT r.id, r.name, r.counterpart_account_id, r.description_template, a.name AS account_name
        FROM public.bank_reconciliation_rules r
        JOIN public.accounts a ON a.id = r.counterpart_account_id
       WHERE r.business_id = _txn.business_id
         AND r.is_active
         AND (r.bank_account_id IS NULL OR r.bank_account_id = _txn.bank_account_id)
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
                                      'No invoice, bill or recorded payment explains this line'),
        'score', 30
      );
    END LOOP;
  END IF;

  -- Tier: derived from evidence classes, never from a bare percentage.
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

REVOKE ALL ON FUNCTION public.bank_match_candidates(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_match_candidates(uuid, integer) TO authenticated;

-- The previous suggestion function referenced a column that does not exist and
-- had no membership assertion. It is retired in favour of the candidate engine.
DROP FUNCTION IF EXISTS public.get_reconciliation_match_suggestions(uuid, uuid, uuid, integer);

-- ============================================================
-- Rules are subordinate to accounting truth
-- ============================================================
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
  _proposed jsonb;
  _cands jsonb;
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

    -- A rule may not categorise away a line that a real document or an
    -- already-recorded payment explains.
    _cands := public.bank_match_candidates(_txn.id, 5);
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
$function$;
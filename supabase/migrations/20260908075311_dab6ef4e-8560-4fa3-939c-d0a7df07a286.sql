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
         AND NOT public._bank_doc_is_spoken_for('payment', p.id)
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
        'evidence', jsonb_build_array('Exact amount')
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
        SELECT p.id, p.amount
          FROM public.payments p
         WHERE p.business_id = _txn.business_id
           AND COALESCE(p.status,'') NOT IN ('voided','cancelled')
           AND p.deposit_account_id IS NOT NULL
           AND p.deposit_account_id <> _bank_gl
           AND (p.branch_id IS NULL OR _txn.branch_id IS NULL OR p.branch_id = _txn.branch_id)
           AND p.amount < _abs
           AND p.payment_date BETWEEN _txn.transaction_date - 30 AND _txn.transaction_date
           AND NOT public._bank_doc_is_spoken_for('payment', p.id)
         ORDER BY p.payment_date DESC
         LIMIT 12
      )
      SELECT jsonb_build_array(
               jsonb_build_object('document_type','payment','document_id', a.id, 'amount', a.amount),
               jsonb_build_object('document_type','payment','document_id', b.id, 'amount', b.amount)
             ) AS allocs
        FROM pool a
        JOIN pool b ON a.id < b.id
       WHERE abs(a.amount + b.amount - _abs) < 0.005
       LIMIT 3
    LOOP
      _cands := _cands || jsonb_build_object(
        'kind', 'payment',
        'label', 'Deposit 2 recorded receipts banked together',
        'effect', 'Debit this bank account, credit the holding accounts of those receipts',
        'allocations', _r.allocs,
        'evidence', jsonb_build_array('The receipts add up to the deposit exactly', 'None of them is yet deposited'),
        'score', 55
      );
    END LOOP;

    -- 1c. A collection batch already banked into this account, awaiting the
    --     bank's confirmation. The banking entry is already posted, so this is
    --     linkage only — never a second settlement.
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
         AND NOT public._bank_doc_is_spoken_for('bill_payment', bp.id)
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
         AND NOT public._bank_doc_is_spoken_for('invoice', i.id)
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
         AND NOT public._bank_doc_is_spoken_for('bill', b.id)
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

  -- 5. A categorisation rule — the weakest evidence there is.
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

CREATE OR REPLACE FUNCTION public.bank_match_confirm(_match_id uuid, _user_id uuid DEFAULT NULL::uuid, _client_request_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _m public.bank_reconciliation_matches;
  _txn public.bank_transactions;
  _kind text;
  _bank_gl uuid;
  _control uuid;
  _fee_account uuid;
  _party uuid;
  _parties uuid[];
  _alloc jsonb;
  _lines jsonb;
  _clearing_lines jsonb := '[]'::jsonb;
  _residual_lines jsonb := '[]'::jsonb;
  _settlement jsonb;
  _payment_id uuid;
  _bill_payment_id uuid;
  _je_id uuid;
  _fee_je uuid;
  _adj_je uuid;
  _rate numeric;
  _base text;
  _txn_currency text;
  _abs numeric;
  _gross numeric;
  _resid numeric;
  _clearing numeric := 0;
  _req text;
  _receipt text;
  _inflow boolean;
  _a jsonb;
  _dep uuid;
  _mirror uuid;
  _dest_gl uuid;
  _cb_id uuid;
BEGIN
  SELECT * INTO _m FROM public.bank_reconciliation_matches WHERE id = _match_id FOR UPDATE;
  IF _m.id IS NULL THEN
    RAISE EXCEPTION 'BANK_MATCH_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF _m.status = 'confirmed' THEN
    RETURN jsonb_build_object('success', true, 'match_id', _match_id, 'already_confirmed', true,
      'journal_entry_id', _m.matched_journal_entry_id, 'payment_id', _m.matched_payment_id,
      'bill_payment_id', _m.matched_bill_payment_id);
  END IF;
  IF _m.status NOT IN ('suggested','to_check') THEN
    RAISE EXCEPTION 'BANK_MATCH_NOT_OPEN' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO _txn FROM public.bank_transactions WHERE id = _m.bank_transaction_id FOR UPDATE;
  IF COALESCE(_txn.is_reconciled, false) THEN
    RAISE EXCEPTION 'BANK_MATCH_ALREADY_RECONCILED' USING ERRCODE = '22023';
  END IF;

  PERFORM public.assert_can_reconcile_bank(_txn.business_id);

  IF NOT public.is_period_open(_txn.business_id, _txn.transaction_date) THEN
    RAISE EXCEPTION 'BANK_MATCH_PERIOD_LOCKED' USING ERRCODE = '22023';
  END IF;

  _kind := public._bank_match_validate(_txn, _m.allocations, _m.fee_amount);

  SELECT account_id INTO _bank_gl
    FROM public.bank_accounts
   WHERE id = _txn.bank_account_id
     AND business_id = _txn.business_id;
  IF _bank_gl IS NULL THEN
    RAISE EXCEPTION 'BANK_ACCOUNT_NEEDS_GL' USING ERRCODE = '22023';
  END IF;

  _abs := abs(_txn.amount);
  _req := COALESCE(_client_request_id, 'bmatch:' || _match_id::text);
  _inflow := COALESCE(_txn.transaction_type, CASE WHEN _txn.amount >= 0 THEN 'credit' ELSE 'debit' END) = 'credit';

  SELECT COALESCE(sum((a->>'amount')::numeric), 0) INTO _gross
    FROM jsonb_array_elements(_m.allocations) a
   WHERE COALESCE(a->>'document_type','') = _kind;
  SELECT COALESCE(sum((a->>'amount')::numeric), 0) INTO _resid
    FROM jsonb_array_elements(_m.allocations) a
   WHERE _kind <> 'account' AND COALESCE(a->>'document_type','') = 'account';

  SELECT base_currency INTO _base FROM public.businesses WHERE id = _txn.business_id;
  _txn_currency := COALESCE(_txn.original_currency,
                            (SELECT ba.currency FROM public.bank_accounts ba WHERE ba.id = _txn.bank_account_id),
                            _base);
  IF _txn_currency IS DISTINCT FROM _base THEN
    _rate := public.require_exchange_rate(_txn.organization_id, _txn.business_id, _txn_currency, _txn.transaction_date);
  ELSE
    _rate := 1;
  END IF;

  IF _kind = 'invoice' THEN
    _control := public._resolve_canonical_default_account('accounts_receivable', _txn.organization_id, _txn.business_id, _txn.branch_id);
    IF _control IS NULL THEN
      RAISE EXCEPTION 'BANK_MATCH_NO_AR_ACCOUNT' USING ERRCODE = '22023';
    END IF;

    SELECT array_agg(DISTINCT i.contact_id) INTO _parties
      FROM jsonb_array_elements(_m.allocations) a
      JOIN public.invoices i ON i.id = (a->>'document_id')::uuid
     WHERE a->>'document_type' = 'invoice';
    IF array_length(_parties, 1) <> 1 THEN
      RAISE EXCEPTION 'BANK_MATCH_MULTIPLE_CUSTOMERS' USING ERRCODE = '22023';
    END IF;
    _party := _parties[1];

    SELECT jsonb_agg(jsonb_build_object('invoice_id', a->>'document_id', 'amount', (a->>'amount')::numeric))
      INTO _alloc FROM jsonb_array_elements(_m.allocations) a WHERE a->>'document_type' = 'invoice';

    _receipt := COALESCE(public.get_next_receipt_number(_txn.organization_id, _txn.business_id, _txn.branch_id),
                         'RCP-BMATCH-' || substr(_match_id::text, 1, 8));

    _settlement := public.record_multi_invoice_payment(
      _org_id := _txn.organization_id,
      _business_id := _txn.business_id,
      _contact_id := _party,
      _allocations := _alloc,
      _total_amount := _gross,
      _payment_date := _txn.transaction_date,
      _payment_method := 'bank_transfer',
      _reference := COALESCE(_txn.reference, 'Bank match: ' || COALESCE(_txn.description, '')),
      _notes := 'Created by bank reconciliation match',
      _receipt_number := _receipt,
      _created_by := _user_id,
      _deposit_account_id := _bank_gl,
      _receivable_account_id := _control,
      _customer_credit_account_id := NULL,
      _branch_id := _txn.branch_id,
      _request_id := _req
    );
    _payment_id := NULLIF(_settlement->>'payment_id','')::uuid;
    _je_id := NULLIF(_settlement->>'journal_entry_id','')::uuid;

  ELSIF _kind = 'bill' THEN
    _control := public._resolve_canonical_default_account('accounts_payable', _txn.organization_id, _txn.business_id, _txn.branch_id);
    IF _control IS NULL THEN
      RAISE EXCEPTION 'BANK_MATCH_NO_AP_ACCOUNT' USING ERRCODE = '22023';
    END IF;

    SELECT array_agg(DISTINCT b.vendor_id) INTO _parties
      FROM jsonb_array_elements(_m.allocations) a
      JOIN public.bills b ON b.id = (a->>'document_id')::uuid
     WHERE a->>'document_type' = 'bill';
    IF array_length(_parties, 1) <> 1 THEN
      RAISE EXCEPTION 'BANK_MATCH_MULTIPLE_VENDORS' USING ERRCODE = '22023';
    END IF;
    _party := _parties[1];

    SELECT jsonb_agg(jsonb_build_object('bill_id', a->>'document_id', 'amount', (a->>'amount')::numeric))
      INTO _alloc FROM jsonb_array_elements(_m.allocations) a WHERE a->>'document_type' = 'bill';

    _settlement := public.record_multi_bill_payment(
      _org_id := _txn.organization_id,
      _business_id := _txn.business_id,
      _vendor_id := _party,
      _allocations := _alloc,
      _total_amount := _gross,
      _payment_date := _txn.transaction_date,
      _payment_method := 'bank_transfer',
      _reference := COALESCE(_txn.reference, 'Bank match: ' || COALESCE(_txn.description, '')),
      _notes := 'Created by bank reconciliation match',
      _created_by := _user_id,
      _bank_account_id := _txn.bank_account_id,
      _payable_account_id := _control,
      _branch_id := _txn.branch_id,
      _request_id := _req
    );
    _bill_payment_id := NULLIF(_settlement->>'bill_payment_id','')::uuid;
    _je_id := NULLIF(_settlement->>'journal_entry_id','')::uuid;

  ELSIF _kind = 'collection_banking' THEN
    -- The banking of a collection batch was posted when it was banked
    -- (Bank Dr / Cash + Mobile money Cr). This statement line is the bank
    -- confirming it: link the existing entry, never post a second one.
    _cb_id := (_m.allocations->0->>'document_id')::uuid;

    SELECT cb.journal_entry_id INTO _je_id
      FROM public.mf_collection_bankings cb
     WHERE cb.id = _cb_id;

    UPDATE public.mf_collection_bankings
       SET bank_transaction_id = _txn.id, updated_at = now()
     WHERE id = _cb_id
       AND bank_transaction_id IS NULL;

  ELSIF _kind IN ('payment','bill_payment') THEN
    FOR _a IN SELECT jsonb_array_elements(_m.allocations) WHERE true LOOP
      CONTINUE WHEN COALESCE(_a->>'document_type','') <> _kind;
      IF _kind = 'payment' THEN
        SELECT p.deposit_account_id INTO _dep FROM public.payments p WHERE p.id = (_a->>'document_id')::uuid;
        IF _payment_id IS NULL THEN _payment_id := (_a->>'document_id')::uuid; END IF;
      ELSE
        SELECT ba.account_id INTO _dep
          FROM public.bill_payments bp
          LEFT JOIN public.bank_accounts ba ON ba.id = bp.bank_account_id
         WHERE bp.id = (_a->>'document_id')::uuid;
        IF _bill_payment_id IS NULL THEN _bill_payment_id := (_a->>'document_id')::uuid; END IF;
      END IF;

      IF _dep IS NULL THEN
        RAISE EXCEPTION 'BANK_MATCH_PAYMENT_NO_HOLDING_ACCOUNT' USING ERRCODE = '22023';
      END IF;

      IF _dep = _bank_gl THEN
        CONTINUE;
      END IF;

      IF EXISTS (SELECT 1 FROM public.bank_accounts ba WHERE ba.account_id = _dep AND ba.business_id = _txn.business_id) THEN
        RAISE EXCEPTION 'BANK_MATCH_PAYMENT_OTHER_BANK_ACCOUNT: this payment settled another bank account — record a transfer instead'
          USING ERRCODE = '22023';
      END IF;

      _clearing := _clearing + (_a->>'amount')::numeric;
      _clearing_lines := _clearing_lines || jsonb_build_object(
        'account_id', _dep,
        'debit',  CASE WHEN _inflow THEN 0 ELSE (_a->>'amount')::numeric END,
        'credit', CASE WHEN _inflow THEN (_a->>'amount')::numeric ELSE 0 END,
        'description', COALESCE(_txn.description, 'Cleared to bank')
      );
    END LOOP;

    IF _clearing > 0 THEN
      _lines := jsonb_build_array(jsonb_build_object(
        'account_id', _bank_gl,
        'debit',  CASE WHEN _inflow THEN _clearing ELSE 0 END,
        'credit', CASE WHEN _inflow THEN 0 ELSE _clearing END,
        'description', COALESCE(_txn.description, 'Bank deposit')
      )) || _clearing_lines;

      _je_id := public.post_journal_entry_atomic(
        _txn.organization_id, _txn.business_id,
        public.generate_next_je_number(_txn.organization_id, _txn.business_id),
        _txn.transaction_date,
        public.get_next_document_number(_txn.organization_id, _txn.business_id, 'BDEP', 'journal_entries', 'reference', 'business_id', 4),
        CASE WHEN _kind = 'payment' THEN 'Deposit of recorded receipts into bank'
             ELSE 'Clearing of recorded supplier payments through bank' END,
        'bank_reconciliation', _txn.id, _user_id, false, false,
        _lines,
        _txn_currency, _rate, 'clearing', _txn.branch_id, false, false
      );
    END IF;

  ELSIF _kind = 'transfer' THEN
    SELECT ba.account_id INTO _dest_gl
      FROM public.bank_accounts ba
     WHERE ba.id = (_m.allocations->0->>'document_id')::uuid;
    IF _dest_gl IS NULL THEN
      RAISE EXCEPTION 'BANK_ACCOUNT_NEEDS_GL' USING ERRCODE = '22023';
    END IF;

    _je_id := public.post_journal_entry_atomic(
      _txn.organization_id, _txn.business_id,
      public.generate_next_je_number(_txn.organization_id, _txn.business_id),
      _txn.transaction_date,
      'BXFER-' || substr(_match_id::text, 1, 8),
      'Bank transfer',
      'bank_reconciliation', _txn.id, _user_id, false, false,
      jsonb_build_array(
        jsonb_build_object('account_id', CASE WHEN _inflow THEN _bank_gl ELSE _dest_gl END,
                           'debit', _gross, 'credit', 0, 'description', COALESCE(_txn.description, 'Bank transfer')),
        jsonb_build_object('account_id', CASE WHEN _inflow THEN _dest_gl ELSE _bank_gl END,
                           'debit', 0, 'credit', _gross, 'description', COALESCE(_txn.description, 'Bank transfer'))
      ),
      _txn_currency, _rate, 'transfer', _txn.branch_id
    );

    _mirror := NULLIF(_m.allocations->0->>'mirror_transaction_id','')::uuid;
    IF _mirror IS NOT NULL THEN
      UPDATE public.bank_transactions
         SET is_reconciled = true, reconciled_type = 'transfer',
             reconciled_entity_id = _txn.bank_account_id,
             reconciled_at = now(), reconciled_by = _user_id,
             journal_entry_id = _je_id, lifecycle_status = 'reconciled', updated_at = now()
       WHERE id = _mirror
         AND business_id = _txn.business_id
         AND COALESCE(is_reconciled, false) = false;
    END IF;

  ELSE
    SELECT jsonb_build_array(
             jsonb_build_object(
               'account_id', _bank_gl,
               'debit',  CASE WHEN _inflow THEN _gross ELSE 0 END,
               'credit', CASE WHEN _inflow THEN 0 ELSE _gross END,
               'description', COALESCE(_txn.description, 'Bank movement')
             )
           ) || COALESCE(jsonb_agg(
             jsonb_build_object(
               'account_id', (a->>'document_id')::uuid,
               'debit',  CASE WHEN _inflow THEN 0 ELSE (a->>'amount')::numeric END,
               'credit', CASE WHEN _inflow THEN (a->>'amount')::numeric ELSE 0 END,
               'description', COALESCE(a->>'description', _txn.description, 'Bank movement')
             )
           ), '[]'::jsonb)
      INTO _lines
      FROM jsonb_array_elements(_m.allocations) a;

    _je_id := public.post_journal_entry_atomic(
      _txn.organization_id, _txn.business_id,
      public.generate_next_je_number(_txn.organization_id, _txn.business_id),
      _txn.transaction_date,
      'BMATCH-' || substr(_match_id::text, 1, 8),
      'Bank reconciliation: classified bank movement',
      'bank_reconciliation', _txn.id, _user_id, false, false,
      _lines,
      _txn_currency, _rate, NULL, _txn.branch_id
    );
  END IF;

  IF _kind <> 'account' AND _resid > 0 THEN
    SELECT jsonb_agg(
             jsonb_build_object(
               'account_id', (a->>'document_id')::uuid,
               'debit',  CASE WHEN _inflow THEN 0 ELSE (a->>'amount')::numeric END,
               'credit', CASE WHEN _inflow THEN (a->>'amount')::numeric ELSE 0 END,
               'description', COALESCE(a->>'description', _txn.description, 'Bank movement')
             )
           ) INTO _residual_lines
      FROM jsonb_array_elements(_m.allocations) a
     WHERE a->>'document_type' = 'account';

    _adj_je := public.post_journal_entry_atomic(
      _txn.organization_id, _txn.business_id,
      public.generate_next_je_number(_txn.organization_id, _txn.business_id),
      _txn.transaction_date,
      'BADJ-' || substr(_match_id::text, 1, 8),
      'Bank reconciliation: named residual on a matched bank line',
      'bank_recon_adjustment', _match_id, _user_id, false, false,
      jsonb_build_array(jsonb_build_object(
        'account_id', _bank_gl,
        'debit',  CASE WHEN _inflow THEN _resid ELSE 0 END,
        'credit', CASE WHEN _inflow THEN 0 ELSE _resid END,
        'description', COALESCE(_txn.description, 'Bank movement')
      )) || _residual_lines,
      _txn_currency, _rate, 'residual', _txn.branch_id
    );
  END IF;

  IF COALESCE(_m.fee_amount, 0) > 0 THEN
    _fee_account := COALESCE(
      _m.fee_account_id,
      public._resolve_canonical_default_account('bank_fees', _txn.organization_id, _txn.business_id, _txn.branch_id)
    );
    IF _fee_account IS NULL THEN
      RAISE EXCEPTION 'BANK_MATCH_NO_FEE_ACCOUNT' USING ERRCODE = '22023';
    END IF;

    _fee_je := public.post_journal_entry_atomic(
      _txn.organization_id, _txn.business_id,
      public.generate_next_je_number(_txn.organization_id, _txn.business_id),
      _txn.transaction_date,
      'BFEE-' || substr(_match_id::text, 1, 8),
      'Bank charge on reconciled bank line',
      'bank_recon', _match_id, _user_id, false, false,
      jsonb_build_array(
        jsonb_build_object('account_id', _fee_account, 'debit', _m.fee_amount, 'credit', 0, 'description', 'Bank charge'),
        jsonb_build_object('account_id', _bank_gl, 'debit', 0, 'credit', _m.fee_amount, 'description', 'Bank charge')
      ),
      _txn_currency, _rate, 'bank_charge', _txn.branch_id
    );
  END IF;

  UPDATE public.bank_transactions SET
    is_reconciled = true,
    reconciled_type = _kind,
    reconciled_entity_id = NULLIF(_m.allocations->0->>'document_id','')::uuid,
    reconciled_at = now(),
    reconciled_by = _user_id,
    journal_entry_id = _je_id,
    reconciled_payment_id = COALESCE(_payment_id, _bill_payment_id),
    lifecycle_status = 'reconciled',
    updated_at = now()
  WHERE id = _txn.id;

  UPDATE public.bank_reconciliation_matches SET
    status = 'confirmed',
    matched_journal_entry_id = _je_id,
    adjustment_journal_entry_id = _adj_je,
    fee_journal_entry_id = _fee_je,
    matched_payment_id = _payment_id,
    matched_bill_payment_id = _bill_payment_id,
    fee_account_id = _fee_account,
    exchange_rate = _rate,
    confidence = 1,
    confirmed_by = _user_id,
    confirmed_at = now(),
    updated_at = now()
  WHERE id = _match_id;

  RETURN jsonb_build_object(
    'success', true,
    'match_id', _match_id,
    'resolution', _kind,
    'journal_entry_id', _je_id,
    'adjustment_journal_entry_id', _adj_je,
    'fee_journal_entry_id', _fee_je,
    'payment_id', _payment_id,
    'bill_payment_id', _bill_payment_id,
    'exchange_rate', _rate
  );
END;
$function$;
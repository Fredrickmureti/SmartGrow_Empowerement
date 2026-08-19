-- =====================================================================
-- Reconciliation engine · Phase 10 — an automation may only post what is
-- unambiguous (ADR-0148).
--
-- WHAT THIS PROVES
--  1. A bank line that is already reconciled, or already carries a proposed
--     match, is not a question: the evidence engine returns no candidates
--     and says so. A replayed statement therefore cannot resurface settled
--     money as a "deterministic" suggestion.
--  2. A document already spoken for by a PROPOSED or CONFIRMED match is
--     never offered again, so the same invoice/receipt/bill/mirror line
--     cannot be proposed against two bank lines at once. The question is
--     asked in exactly one place (`_bank_doc_is_spoken_for`).
--  3. Several possible receipt combinations for one deposit surface as
--     several candidates (hence `ambiguous`) — they no longer cancel each
--     other out and vanish.
--  4. The rules runner skips lines that already have a proposal, refuses
--     when two equally-ranked rules claim a line, and never auto-posts an
--     ambiguous or already-explained line.
--  5. Statement ingest stays idempotent: a fingerprint plus
--     ON CONFLICT DO NOTHING, so a re-import counts duplicates rather than
--     minting a second line for the same movement.
--
-- Run with: supabase test db --linked --file bank_match_automation_invariants_test.sql
-- =====================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- 1) The evidence engine refuses to speculate about an explained line.
-- ---------------------------------------------------------------------
DO $$
DECLARE v text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='bank_match_candidates';

  IF v IS NULL THEN
    RAISE EXCEPTION 'bank_match_candidates is missing';
  END IF;

  -- The short-circuit must read the line's own matches, not just the flag:
  -- a proposal is an open decision even though is_reconciled is still false.
  IF v NOT LIKE '%m.bank_transaction_id = _txn_id%' THEN
    RAISE EXCEPTION 'the evidence engine does not look for this line''s own match';
  END IF;
  IF v NOT LIKE '%''confirmed'', ''proposed''%' AND v NOT LIKE '%''proposed'', ''confirmed''%' THEN
    RAISE EXCEPTION 'the short-circuit does not consider both confirmed and proposed matches';
  END IF;
  IF v NOT LIKE '%''settled''%' THEN
    RAISE EXCEPTION 'a reconciled line is not reported as settled';
  END IF;
  IF v NOT LIKE '%''proposed''%' THEN
    RAISE EXCEPTION 'a line with an open proposal is not reported as proposed';
  END IF;
  IF v NOT LIKE '%existing_match_id%' THEN
    RAISE EXCEPTION 'the existing match is not surfaced, so the client cannot show it instead';
  END IF;
  IF v NOT LIKE '%COALESCE(_txn.is_reconciled, false)%' THEN
    RAISE EXCEPTION 'the reconciled flag is not part of the short-circuit';
  END IF;

  -- Every candidate class must ask the "already spoken for" question, and it
  -- must be the same question (one helper), not five hand-rolled NOT EXISTS.
  IF (SELECT count(*) FROM regexp_matches(v, '_bank_doc_is_spoken_for', 'g')) < 5 THEN
    RAISE EXCEPTION 'not every candidate class checks whether the document is already spoken for';
  END IF;
  FOR v IN SELECT unnest(ARRAY['payment', 'bill_payment', 'invoice', 'bill']) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='bank_match_candidates'
         AND pg_get_functiondef(p.oid) LIKE '%_bank_doc_is_spoken_for(''' || v || '''%'
    ) THEN
      RAISE EXCEPTION 'the % candidate class can offer a document that is already spoken for', v;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 2) The "spoken for" question: one definition, proposal-aware, internal.
-- ---------------------------------------------------------------------
DO $$
DECLARE r record; v text;
BEGIN
  SELECT p.prosecdef, p.proconfig, p.proacl, p.proowner, pg_get_functiondef(p.oid) AS def
    INTO r
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='_bank_doc_is_spoken_for';

  IF r.def IS NULL THEN
    RAISE EXCEPTION '_bank_doc_is_spoken_for is missing';
  END IF;
  IF NOT r.prosecdef THEN
    RAISE EXCEPTION '_bank_doc_is_spoken_for is not SECURITY DEFINER';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(r.proconfig,'{}')) c WHERE c LIKE 'search\_path=%') THEN
    RAISE EXCEPTION '_bank_doc_is_spoken_for has no pinned search_path';
  END IF;

  -- Internal to the seam: not part of the client API, and never anonymous.
  IF EXISTS (
    SELECT 1 FROM aclexplode(COALESCE(r.proacl, acldefault('f', r.proowner))) a
    WHERE a.privilege_type='EXECUTE'
      AND a.grantee IN (0,
        (SELECT oid FROM pg_roles WHERE rolname='anon'),
        (SELECT oid FROM pg_roles WHERE rolname='authenticated'))
  ) THEN
    RAISE EXCEPTION '_bank_doc_is_spoken_for is callable from the client API';
  END IF;

  -- A proposal reserves the document too; only confirmed would be too weak.
  IF r.def NOT LIKE '%''proposed''%' OR r.def NOT LIKE '%''confirmed''%' THEN
    RAISE EXCEPTION 'the reservation ignores proposed or confirmed matches';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 3) Ambiguity surfaces instead of cancelling out.
--    The multi-receipt query must emit one candidate per combination, so
--    two combinations tie at the top score and the tier is `ambiguous`.
-- ---------------------------------------------------------------------
DO $$
DECLARE v text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='bank_match_candidates';

  -- The old shape aggregated every pair into one row and then required
  -- exactly two members, so N>1 possibilities produced nothing at all.
  IF v LIKE '%HAVING count(*) = 2%' THEN
    RAISE EXCEPTION 'the multi-receipt query still collapses all combinations into one row';
  END IF;
  IF v NOT LIKE '%JOIN pool b ON a.id < b.id%' THEN
    RAISE EXCEPTION 'the multi-receipt query does not enumerate combinations';
  END IF;

  -- The tie itself must still be what makes a line ambiguous.
  IF v NOT LIKE '%_top_count > 1%' OR v NOT LIKE '%''ambiguous''%' THEN
    RAISE EXCEPTION 'a tie at the top score no longer yields the ambiguous tier';
  END IF;

  -- A tier is derived from evidence, never asserted by the caller.
  IF v ~* '_tier\s*:=\s*_' AND v !~* '_tier := CASE' THEN
    RAISE EXCEPTION 'the tier is taken from an input rather than derived';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 4) The rules runner: no re-proposal, no rule race, no ambiguous post.
-- ---------------------------------------------------------------------
DO $$
DECLARE v text; token text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='apply_reconciliation_rules';

  FOREACH token IN ARRAY ARRAY[
    'AMBIGUOUS_RULE_MATCH',        -- two equally-ranked rules claim the line
    'AMBIGUOUS_NOT_AUTO_POSTED',   -- an ambiguous line stays a proposal
    'LINE_ALREADY_EXPLAINED',      -- settled or already proposed
    'DOCUMENT_CANDIDATE_EXISTS',   -- a document outranks a category
    'RULE_HAS_NO_COUNTERPART_ACCOUNT',
    'assert_can_reconcile_bank',
    'bank_match_propose',
    'bank_match_confirm'
  ] LOOP
    IF v NOT LIKE '%' || token || '%' THEN
      RAISE EXCEPTION 'the rules runner does not handle/enforce %', token;
    END IF;
  END LOOP;

  -- The candidate loop must exclude lines that already carry a match.
  IF v NOT LIKE '%m.bank_transaction_id = t.id%' THEN
    RAISE EXCEPTION 'the rules runner re-proposes lines that already have a match';
  END IF;

  -- Auto-post is gated on the derived tier, not on the rule''s own opinion.
  IF v NOT LIKE '%_tier := _cands->>''tier''%' THEN
    RAISE EXCEPTION 'the rules runner ignores the derived tier';
  END IF;
  IF v NOT LIKE '%_rule.auto_post AND _tier = ''ambiguous''%' THEN
    RAISE EXCEPTION 'an ambiguous line can still be auto-posted';
  END IF;

  -- It remains a proposer, never a poster of its own.
  IF v ~* 'insert\s+into\s+(public\.)?journal_entr' THEN
    RAISE EXCEPTION 'ADR-0123 violated: the rules runner posts journal rows directly';
  END IF;
  IF v ~* 'update\s+(public\.)?bank_transactions\s+set[^;]*is_reconciled' THEN
    RAISE EXCEPTION 'the rules runner flips reconciled state outside the seam';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 5) Ingest idempotence: a replayed statement is a duplicate, not a line.
-- ---------------------------------------------------------------------
DO $$
DECLARE v text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='bank_statement_import_batch';

  IF v NOT LIKE '%bank_transaction_fingerprint%' THEN
    RAISE EXCEPTION 'statement ingest has no fingerprint, so a re-import cannot be recognised';
  END IF;
  IF v NOT LIKE '%ON CONFLICT (bank_account_id, external_transaction_id) DO NOTHING%' THEN
    RAISE EXCEPTION 'statement ingest does not dedupe on the fingerprint';
  END IF;
  IF v NOT LIKE '%v_duplicates%' THEN
    RAISE EXCEPTION 'a duplicated line is not reported back to the operator';
  END IF;

  -- The identity must be unique in the schema, not merely respected by the
  -- one writer that happens to say ON CONFLICT.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_class t ON t.oid = x.indrelid
     WHERE t.relname = 'bank_transactions'
       AND x.indisunique
       AND pg_get_indexdef(i.oid) LIKE '%external_transaction_id%'
       AND pg_get_indexdef(i.oid) LIKE '%bank_account_id%'
  ) THEN
    RAISE EXCEPTION 'no unique index enforces one bank line per statement movement';
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- 6) BEHAVIOURAL 10.1 + 10.2 — an explained line is not a question, and a
--    reserved document is never offered twice.
--    Uses live rows, proves the behaviour, then rolls itself back.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_biz uuid; v_txn uuid; v_txn2 uuid; v_pay uuid; v_amt numeric;
  v_match uuid; v_res jsonb;
BEGIN
  SELECT p.business_id, p.id, p.amount, t.id
    INTO v_biz, v_pay, v_amt, v_txn
    FROM public.payments p
    JOIN public.bank_transactions t
      ON t.business_id = p.business_id
     AND COALESCE(t.is_reconciled, false) = false
     AND abs(t.amount) = p.amount
     AND COALESCE(t.transaction_type, CASE WHEN t.amount >= 0 THEN 'credit' ELSE 'debit' END) = 'credit'
    JOIN public.bank_accounts ba ON ba.id = t.bank_account_id
   WHERE COALESCE(p.status, 'completed') NOT IN ('voided','cancelled')
     AND p.deposit_account_id IS NOT NULL
     AND ba.account_id IS NOT NULL
     AND p.deposit_account_id <> ba.account_id
     AND public.is_period_open(p.business_id, t.transaction_date)
     AND NOT EXISTS (
       SELECT 1 FROM public.bank_reconciliation_matches m
        WHERE m.bank_transaction_id = t.id AND m.status IN ('proposed','confirmed'))
     AND NOT EXISTS (
       SELECT 1 FROM public.bank_reconciliation_matches m
        WHERE m.status IN ('proposed','confirmed')
          AND m.allocations @> jsonb_build_array(
                jsonb_build_object('document_type','payment','document_id', p.id::text)))
   ORDER BY t.transaction_date DESC
   LIMIT 1;

  IF v_txn IS NULL THEN
    RAISE NOTICE '10.1/10.2 skipped — no undeposited-receipt fixture present';
    RETURN;
  END IF;

  -- A second unreconciled inflow of the same amount, to prove the reservation.
  SELECT t.id INTO v_txn2
    FROM public.bank_transactions t
   WHERE t.business_id = v_biz AND t.id <> v_txn
     AND COALESCE(t.is_reconciled, false) = false
     AND abs(t.amount) = v_amt
     AND COALESCE(t.transaction_type, CASE WHEN t.amount >= 0 THEN 'credit' ELSE 'debit' END) = 'credit'
   LIMIT 1;

  v_match := (public.bank_match_propose(
    _txn_id := v_txn,
    _allocations := jsonb_build_array(jsonb_build_object(
      'document_type','payment','document_id', v_pay, 'amount', v_amt)),
    _fee_amount := 0, _match_type := 'manual', _rule_id := NULL,
    _notes := 'behavioural 10.1', _user_id := NULL)->>'match_id')::uuid;

  -- (a) the proposed line answers `proposed`, offers nothing, names its match
  v_res := public.bank_match_candidates(v_txn, 10);
  IF v_res->>'tier' <> 'proposed' THEN
    RAISE EXCEPTION '10.1: a line carrying a proposal reported tier % instead of proposed', v_res->>'tier';
  END IF;
  IF jsonb_array_length(COALESCE(v_res->'candidates','[]'::jsonb)) <> 0 THEN
    RAISE EXCEPTION '10.1: a line with an open proposal still received % speculative candidate(s)',
      jsonb_array_length(v_res->'candidates');
  END IF;
  IF (v_res->>'existing_match_id')::uuid IS DISTINCT FROM v_match THEN
    RAISE EXCEPTION '10.1: the open decision was not surfaced to the client';
  END IF;

  -- (b) the reserved receipt cannot be offered on another line
  IF v_txn2 IS NOT NULL THEN
    v_res := public.bank_match_candidates(v_txn2, 10);
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(v_res->'candidates','[]'::jsonb)) c,
                    jsonb_array_elements(COALESCE(c->'allocations','[]'::jsonb)) a
       WHERE a->>'document_id' = v_pay::text
    ) THEN
      RAISE EXCEPTION '10.2: a receipt already spoken for was offered on a second bank line';
    END IF;
  END IF;

  -- (c) once confirmed the line is settled, still with no candidates
  PERFORM public.bank_match_confirm(v_match, NULL, 'behavioural:' || v_txn::text);
  v_res := public.bank_match_candidates(v_txn, 10);
  IF v_res->>'tier' <> 'settled' THEN
    RAISE EXCEPTION '10.1: a reconciled line reported tier % instead of settled', v_res->>'tier';
  END IF;
  IF jsonb_array_length(COALESCE(v_res->'candidates','[]'::jsonb)) <> 0 THEN
    RAISE EXCEPTION '10.1: a settled line was re-offered as a suggestion';
  END IF;

  RAISE NOTICE '10.1/10.2 hold (explained lines answer settled/proposed; reserved documents are not re-offered)';
  RAISE EXCEPTION 'rollback: behavioural block complete';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'rollback: behavioural block complete' THEN RAISE; END IF;
END $$;

-- ---------------------------------------------------------------------
-- 7) BEHAVIOURAL 10.4 + 10.5 — a rules sweep is idempotent, and a rule race
--    is an ambiguity that posts nothing.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_ba record; v_txn record; v_acct_a uuid; v_acct_b uuid;
  v_r1 uuid; v_r2 uuid; v_res jsonb; v_before int; v_after int;
BEGIN
  SELECT ba.* INTO v_ba
    FROM public.bank_accounts ba
   WHERE ba.account_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.bank_transactions t
        WHERE t.bank_account_id = ba.id
          AND COALESCE(t.is_reconciled, false) = false
          AND public.is_period_open(t.business_id, t.transaction_date)
          AND NOT EXISTS (SELECT 1 FROM public.bank_reconciliation_matches m
                           WHERE m.bank_transaction_id = t.id
                             AND m.status IN ('proposed','confirmed')))
   ORDER BY ba.created_at LIMIT 1;

  IF v_ba.id IS NULL THEN
    RAISE NOTICE '10.4/10.5 skipped — no bank account with an open unexplained line';
    RETURN;
  END IF;

  SELECT t.* INTO v_txn
    FROM public.bank_transactions t
   WHERE t.bank_account_id = v_ba.id
     AND COALESCE(t.is_reconciled, false) = false
     AND public.is_period_open(t.business_id, t.transaction_date)
     AND NOT EXISTS (SELECT 1 FROM public.bank_reconciliation_matches m
                      WHERE m.bank_transaction_id = t.id
                        AND m.status IN ('proposed','confirmed'))
   ORDER BY t.transaction_date LIMIT 1;

  SELECT id INTO v_acct_a FROM public.accounts
   WHERE business_id = v_ba.business_id AND COALESCE(is_active, true) ORDER BY code LIMIT 1;
  SELECT id INTO v_acct_b FROM public.accounts
   WHERE business_id = v_ba.business_id AND COALESCE(is_active, true) AND id <> v_acct_a
   ORDER BY code DESC LIMIT 1;

  IF v_acct_a IS NULL OR v_acct_b IS NULL THEN
    RAISE NOTICE '10.4/10.5 skipped — fewer than two counterpart accounts available';
    RETURN;
  END IF;

  -- Two active rules, equal priority, different counterparts: a genuine race.
  INSERT INTO public.bank_reconciliation_rules
    (organization_id, business_id, bank_account_id, name, priority, is_active,
     amount_sign, counterpart_account_id, auto_post)
  VALUES (v_ba.organization_id, v_ba.business_id, v_ba.id, 'behavioural rule A', 10, true,
          'any', v_acct_a, true)
  RETURNING id INTO v_r1;
  INSERT INTO public.bank_reconciliation_rules
    (organization_id, business_id, bank_account_id, name, priority, is_active,
     amount_sign, counterpart_account_id, auto_post)
  VALUES (v_ba.organization_id, v_ba.business_id, v_ba.id, 'behavioural rule B', 10, true,
          'any', v_acct_b, true)
  RETURNING id INTO v_r2;

  SELECT count(*) INTO v_before FROM public.bank_reconciliation_matches
   WHERE bank_transaction_id = v_txn.id;

  v_res := public.apply_reconciliation_rules(v_ba.id, NULL, 50);

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(v_res->'skipped','[]'::jsonb)) s
     WHERE s->>'reason' = 'AMBIGUOUS_RULE_MATCH'
  ) THEN
    RAISE EXCEPTION '10.5: two equally-ranked rules did not raise AMBIGUOUS_RULE_MATCH (%)', v_res;
  END IF;

  SELECT count(*) INTO v_after FROM public.bank_reconciliation_matches
   WHERE bank_transaction_id = v_txn.id;
  IF v_after <> v_before THEN
    RAISE EXCEPTION '10.5: an ambiguous rule race still produced % match row(s)', v_after - v_before;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.bank_reconciliation_matches m
     WHERE m.rule_id IN (v_r1, v_r2) AND m.status = 'confirmed'
  ) THEN
    RAISE EXCEPTION '10.5: an ambiguous rule auto-posted';
  END IF;

  -- Resolve the race, then prove the sweep is idempotent.
  UPDATE public.bank_reconciliation_rules SET is_active = false, auto_post = false WHERE id = v_r2;
  UPDATE public.bank_reconciliation_rules SET auto_post = false WHERE id = v_r1;

  PERFORM public.apply_reconciliation_rules(v_ba.id, NULL, 50);
  SELECT count(*) INTO v_before FROM public.bank_reconciliation_matches WHERE rule_id = v_r1;
  PERFORM public.apply_reconciliation_rules(v_ba.id, NULL, 50);
  SELECT count(*) INTO v_after FROM public.bank_reconciliation_matches WHERE rule_id = v_r1;

  IF v_after <> v_before THEN
    RAISE EXCEPTION '10.4: a replayed sweep created % duplicate proposal(s)', v_after - v_before;
  END IF;

  RAISE NOTICE '10.4/10.5 hold (a rule race is refused and posts nothing; a replayed sweep proposes once)';
  RAISE EXCEPTION 'rollback: behavioural block complete';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'rollback: behavioural block complete' THEN RAISE; END IF;
END $$;

-- ---------------------------------------------------------------------
-- 8) BEHAVIOURAL 10.3 — several receipt combinations for one deposit surface
--    as several candidates, and the tier is `ambiguous`.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_ba record; v_txn uuid; v_pair record; v_res jsonb; v_tops int;
BEGIN
  SELECT ba.* INTO v_ba FROM public.bank_accounts ba
   WHERE ba.account_id IS NOT NULL ORDER BY ba.created_at LIMIT 1;
  IF v_ba.id IS NULL THEN
    RAISE NOTICE '10.3 skipped — no bank account with a GL account';
    RETURN;
  END IF;

  -- Two disjoint receipt pairs with the same total: the deposit is genuinely
  -- explainable in more than one way.
  WITH pool AS (
    SELECT p.id, p.amount
      FROM public.payments p
     WHERE p.business_id = v_ba.business_id
       AND p.deposit_account_id IS NOT NULL
       AND p.deposit_account_id <> v_ba.account_id
       AND COALESCE(p.status,'completed') NOT IN ('voided','cancelled')
       AND NOT EXISTS (
         SELECT 1 FROM public.bank_reconciliation_matches m
          WHERE m.status IN ('proposed','confirmed')
            AND m.allocations @> jsonb_build_array(
                  jsonb_build_object('document_type','payment','document_id', p.id::text)))
     LIMIT 40
  ), pairs AS (
    SELECT a.id AS a1, b.id AS a2, a.amount + b.amount AS total
      FROM pool a JOIN pool b ON a.id < b.id
  )
  SELECT total, count(*) AS combos INTO v_pair
    FROM pairs GROUP BY total HAVING count(*) > 1
   ORDER BY count(*) DESC LIMIT 1;

  IF v_pair.total IS NULL THEN
    RAISE NOTICE '10.3 skipped — no deposit is explainable by two different receipt pairs';
    RETURN;
  END IF;

  INSERT INTO public.bank_transactions
    (organization_id, business_id, bank_account_id, branch_id, transaction_date,
     amount, transaction_type, description, is_reconciled)
  VALUES (v_ba.organization_id, v_ba.business_id, v_ba.id, v_ba.branch_id, CURRENT_DATE,
          v_pair.total, 'credit', 'behavioural 10.3 deposit', false)
  RETURNING id INTO v_txn;

  v_res := public.bank_match_candidates(v_txn, 10);

  IF jsonb_array_length(COALESCE(v_res->'candidates','[]'::jsonb)) < 2 THEN
    RAISE EXCEPTION '10.3: % combinations collapsed into % candidate(s)',
      v_pair.combos, jsonb_array_length(COALESCE(v_res->'candidates','[]'::jsonb));
  END IF;
  IF v_res->>'tier' <> 'ambiguous' THEN
    RAISE EXCEPTION '10.3: a deposit with several explanations reported tier % instead of ambiguous',
      v_res->>'tier';
  END IF;

  RAISE NOTICE '10.3 holds (competing combinations surface and the line is ambiguous)';
  RAISE EXCEPTION 'rollback: behavioural block complete';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'rollback: behavioural block complete' THEN RAISE; END IF;
END $$;

SELECT 'bank_match_automation_invariants: ok' AS result;

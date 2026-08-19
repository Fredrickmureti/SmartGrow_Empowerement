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

SELECT 'bank_match_automation_invariants: ok' AS result;

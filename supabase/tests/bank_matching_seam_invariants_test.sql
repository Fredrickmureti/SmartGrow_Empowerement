-- =====================================================================
-- Finance Wave 2 · Phase 13 — the bank matching seam, asserted in SQL.
--
-- WHAT THIS PROVES (D-9, D-10, D-11, D-12)
-- 1. There is exactly ONE matching seam: propose / confirm / reject /
--    reverse, each hardened (SECURITY DEFINER, pinned search_path, no
--    anon/PUBLIC execute) and single-overload.
-- 2. The seam REFUSES rather than guesses: unbalanced allocation sets,
--    over-allocation, mixed document types, cross-company documents,
--    locked periods, missing FX rate, missing control/fee account.
-- 3. The seam never mints journals or payments itself — settlement is
--    delegated to record_multi_invoice_payment / record_multi_bill_payment
--    and GL to post_journal_entry_atomic (ADR-0123).
-- 4. A bank charge posts exactly two lines (charge + bank), never a
--    plugged single-sided entry.
-- 5. Confirmation is idempotent through a client request id.
-- 6. Reverse restores the line to review through the canonical
--    unreconcile seam; reject preserves provenance instead of deleting.
-- 7. Suggestions are business-scoped (D-11) and the legacy one-to-one RPC
--    is a shim over the seam that cannot skip GL (D-12).
--
-- Run with: supabase test db --linked --file bank_matching_seam_invariants_test.sql
-- =====================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- 1) Exactly one seam, hardened, not anonymous.
-- ---------------------------------------------------------------------
DO $$
DECLARE seam text; r record;
BEGIN
  FOREACH seam IN ARRAY ARRAY[
    'bank_match_propose',
    'bank_match_confirm',
    'bank_match_reject',
    'bank_match_reverse'
  ] LOOP
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname=seam) <> 1 THEN
      RAISE EXCEPTION 'matching seam % must have exactly one overload', seam;
    END IF;

    SELECT p.prosecdef, p.proconfig, p.proacl, p.proowner INTO r
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname=seam;

    IF NOT r.prosecdef THEN
      RAISE EXCEPTION 'matching seam % is not SECURITY DEFINER', seam;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(r.proconfig,'{}')) c WHERE c LIKE 'search\_path=%') THEN
      RAISE EXCEPTION 'matching seam % has no pinned search_path', seam;
    END IF;
    IF EXISTS (
      SELECT 1 FROM aclexplode(COALESCE(r.proacl, acldefault('f', r.proowner))) a
      WHERE a.privilege_type='EXECUTE'
        AND a.grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname='anon'))
    ) THEN
      RAISE EXCEPTION 'matching seam % is executable by anon/PUBLIC', seam;
    END IF;
  END LOOP;

  -- The internal validator: single overload, pinned search_path, never
  -- reachable from the client surface (it is a plain helper, not a seam).
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='_bank_match_validate') <> 1 THEN
    RAISE EXCEPTION '_bank_match_validate must have exactly one overload';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL unnest(COALESCE(p.proconfig,'{}')) c
    WHERE n.nspname='public' AND p.proname='_bank_match_validate' AND c LIKE 'search\_path=%'
  ) THEN
    RAISE EXCEPTION '_bank_match_validate has no pinned search_path';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE n.nspname='public' AND p.proname='_bank_match_validate'
      AND a.privilege_type='EXECUTE'
      AND a.grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname='anon'))
  ) THEN
    RAISE EXCEPTION '_bank_match_validate is executable by anon/PUBLIC';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE n.nspname='public' AND p.proname='_bank_match_validate'
      AND a.privilege_type='EXECUTE'
      AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname='authenticated')
  ) THEN
    RAISE EXCEPTION '_bank_match_validate is directly callable by authenticated';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2) The allocation model exists on the match row (n:m, partial, fee).
-- ---------------------------------------------------------------------
DO $$
DECLARE col text;
BEGIN
  FOREACH col IN ARRAY ARRAY['allocations','fee_amount','fee_account_id','exchange_rate','proposed_by','rejected_by'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='bank_reconciliation_matches' AND column_name=col
    ) THEN
      RAISE EXCEPTION 'D-9 regression: bank_reconciliation_matches.% is missing (no n:m / fee representation)', col;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 3) The validator refuses instead of guessing.
-- ---------------------------------------------------------------------
DO $$
DECLARE v text; token text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='_bank_match_validate';

  FOREACH token IN ARRAY ARRAY[
    'BANK_MATCH_NO_ALLOCATIONS',           -- empty set
    'BANK_MATCH_NONPOSITIVE_ALLOCATION',   -- zero/negative leg
    'BANK_MATCH_NEGATIVE_FEE',
    'BANK_MATCH_EXCEEDS_OPEN_AMOUNT',      -- over-allocation
    'BANK_MATCH_MIXED_DOCUMENT_TYPES',     -- invoice + bill in one set
    'BANK_MATCH_CROSS_COMPANY',            -- multi-tenancy
    'BANK_MATCH_UNBALANCED'                -- allocations + fee <> bank line
  ] LOOP
    IF v NOT LIKE '%' || token || '%' THEN
      RAISE EXCEPTION 'the matching validator does not refuse %', token;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 4) Confirmation: period lock, FX, canonical resolution, idempotency.
-- ---------------------------------------------------------------------
DO $$
DECLARE v text; token text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='bank_match_confirm';

  FOREACH token IN ARRAY ARRAY[
    'assert_can_reconcile_bank',        -- authorization
    'is_period_open',                   -- locked period refused
    'BANK_MATCH_PERIOD_LOCKED',
    '_bank_match_validate',             -- revalidated against live open amounts
    'require_exchange_rate',            -- D-10: no hardcoded rate
    '_resolve_canonical_default_account',
    'BANK_MATCH_NO_AR_ACCOUNT',
    'BANK_MATCH_NO_AP_ACCOUNT',
    'BANK_MATCH_NO_FEE_ACCOUNT',
    'record_multi_invoice_payment',     -- settlement delegated, not reimplemented
    'record_multi_bill_payment',
    'post_journal_entry_atomic',
    '_client_request_id',               -- idempotency key
    'FOR UPDATE'                        -- serialized against a concurrent confirm
  ] LOOP
    IF v NOT LIKE '%' || token || '%' THEN
      RAISE EXCEPTION 'bank_match_confirm does not use/enforce %', token;
    END IF;
  END LOOP;

  -- D-10: an exchange rate must never be assumed for a foreign-currency line.
  IF v ~* '_rate\s*:=\s*1\s*;' AND v NOT LIKE '%require_exchange_rate%' THEN
    RAISE EXCEPTION 'D-10 regression: bank_match_confirm hardcodes an exchange rate';
  END IF;

  -- The seam must not write journal rows itself.
  IF v ~* 'insert\s+into\s+(public\.)?journal_entr' THEN
    RAISE EXCEPTION 'ADR-0123 violated: bank_match_confirm inserts journal rows directly';
  END IF;
  -- ...nor mint payments outside the settlement engines.
  IF v ~* 'insert\s+into\s+(public\.)?(payments|bill_payments|customer_payments)\b' THEN
    RAISE EXCEPTION 'ADR-0123 violated: bank_match_confirm mints payments';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 5) The bank charge residual posts exactly two lines.
-- ---------------------------------------------------------------------
DO $$
DECLARE v text; v_fee text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='bank_match_confirm';

  v_fee := substring(v from 'BFEE(.*?)END IF;');
  IF v_fee IS NULL THEN
    RAISE EXCEPTION 'bank_match_confirm has no bank-charge residual branch';
  END IF;
  IF (length(v_fee) - length(replace(v_fee, 'jsonb_build_object', ''))) / length('jsonb_build_object') <> 2 THEN
    RAISE EXCEPTION 'the bank charge must post exactly two lines (charge + bank)';
  END IF;
  IF v_fee NOT LIKE '%bank_charge%' THEN
    RAISE EXCEPTION 'the bank charge entry is not tagged as a bank_charge';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 6) Reject preserves provenance; reverse routes through unreconcile.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_rej text; v_rev text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_rej FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='bank_match_reject';
  SELECT pg_get_functiondef(p.oid) INTO v_rev FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='bank_match_reverse';

  IF v_rej ~* 'delete\s+from\s+(public\.)?bank_reconciliation_matches' THEN
    RAISE EXCEPTION 'reject deletes the proposal instead of preserving provenance';
  END IF;
  IF v_rej NOT LIKE '%rejected%' THEN
    RAISE EXCEPTION 'reject does not record a rejected state';
  END IF;
  IF v_rej NOT LIKE '%BANK_MATCH_NOT_OPEN%' THEN
    RAISE EXCEPTION 'a settled match can be rejected';
  END IF;

  IF v_rev NOT LIKE '%BANK_MATCH_NOT_CONFIRMED%' THEN
    RAISE EXCEPTION 'an unconfirmed match can be reversed';
  END IF;
  IF v_rev NOT LIKE '%unreconcile_bank_transaction%' THEN
    RAISE EXCEPTION 'reverse does not delegate to the canonical unreconcile seam (for_review restore)';
  END IF;
END $$;

-- The canonical unreconcile seam is what restores the review state.
DO $$
DECLARE v text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='unreconcile_bank_transaction';
  IF v IS NULL THEN
    RAISE EXCEPTION 'unreconcile_bank_transaction is missing';
  END IF;
  IF v NOT LIKE '%for_review%' THEN
    RAISE EXCEPTION 'unreconcile does not restore the line to for_review';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 7) D-11: suggestions are business-scoped. D-12: one rule engine.
-- ---------------------------------------------------------------------
DO $$
DECLARE v text; n_overloads int;
BEGIN
  SELECT count(*) INTO n_overloads FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_reconciliation_match_suggestions';
  IF n_overloads <> 1 THEN
    RAISE EXCEPTION 'D-11 regression: get_reconciliation_match_suggestions has % overloads (the org-only signature must stay dropped)', n_overloads;
  END IF;

  SELECT pg_get_function_identity_arguments(p.oid) INTO v
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_reconciliation_match_suggestions';
  IF v IS NULL THEN
    RAISE EXCEPTION 'get_reconciliation_match_suggestions is missing';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_reconciliation_match_suggestions';
  IF v NOT LIKE '%business_id%' THEN
    RAISE EXCEPTION 'D-11 regression: suggestions are not business-scoped';
  END IF;

  -- The rule engine proposes through the seam; it never writes matches itself.
  SELECT pg_get_functiondef(p.oid) INTO v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='apply_reconciliation_rules';
  IF v IS NULL THEN
    RAISE EXCEPTION 'apply_reconciliation_rules is missing';
  END IF;
  IF v NOT LIKE '%bank_match_propose%' THEN
    RAISE EXCEPTION 'D-12 regression: the rule engine does not propose through the seam';
  END IF;
  IF v ~* 'insert\s+into\s+(public\.)?bank_reconciliation_matches' THEN
    RAISE EXCEPTION 'D-12 regression: the rule engine writes matches directly (second engine)';
  END IF;

  -- The legacy one-to-one RPC is a shim and cannot skip the GL.
  SELECT pg_get_functiondef(p.oid) INTO v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='reconcile_bank_transaction_atomic';
  IF v IS NOT NULL THEN
    IF v NOT LIKE '%bank_match_propose%' OR v NOT LIKE '%bank_match_confirm%' THEN
      RAISE EXCEPTION 'the legacy reconcile RPC is not a shim over the matching seam';
    END IF;
    IF v ~* 'insert\s+into\s+(public\.)?journal_entr' THEN
      RAISE EXCEPTION 'the legacy reconcile RPC still posts journals itself';
    END IF;
  END IF;
END $$;

SELECT 'bank_matching_seam_invariants: ok' AS result;

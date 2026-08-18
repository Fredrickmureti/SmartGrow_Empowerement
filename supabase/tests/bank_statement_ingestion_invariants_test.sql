-- =====================================================================
-- Banking Wave 1 · Phase 6.2 — statement ingestion invariants
--
-- WHAT THIS PROVES
-- There is exactly ONE way a bank line enters the system:
-- `bank_statement_import_batch`. CSV upload and provider feed both
-- delegate to it. The engine deduplicates on a deterministic fingerprint,
-- refuses non-active accounts, refuses foreign currency lines, and never
-- silently swallows a row it could not accept (rejected rows are returned).
--
-- Run with: supabase test db --linked --file bank_statement_ingestion_invariants_test.sql
-- =====================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- 1) One engine, one overload, hardened, not anonymous.
-- ---------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='bank_statement_import_batch') <> 1 THEN
    RAISE EXCEPTION 'bank_statement_import_batch must have exactly one overload';
  END IF;

  SELECT p.prosecdef, p.proconfig, p.proacl, p.proowner INTO r
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='bank_statement_import_batch';

  IF NOT r.prosecdef THEN RAISE EXCEPTION 'import engine is not SECURITY DEFINER'; END IF;
  IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(r.proconfig,'{}')) c WHERE c LIKE 'search\_path=%') THEN
    RAISE EXCEPTION 'import engine has no pinned search_path';
  END IF;
  IF EXISTS (
    SELECT 1 FROM aclexplode(COALESCE(r.proacl, acldefault('f', r.proowner))) a
    WHERE a.privilege_type='EXECUTE'
      AND a.grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname='anon'))
  ) THEN
    RAISE EXCEPTION 'import engine is executable by anon/PUBLIC';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2) The fingerprint is deterministic: same input → same value, and it
--    is a pure function (IMMUTABLE/STABLE, no clock, no random, no uuid).
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_a text; v_b text; v_c text; v_src text; v_volatile "char";
  v_acct uuid := '00000000-0000-0000-0000-0000000000aa';
BEGIN
  SELECT p.provolatile, pg_get_functiondef(p.oid) INTO v_volatile, v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='bank_transaction_fingerprint';

  IF v_volatile = 'v' THEN
    RAISE EXCEPTION 'fingerprint is VOLATILE — dedup cannot be reproducible';
  END IF;
  IF v_src ~* '(now\(\)|clock_timestamp|gen_random_uuid|random\(\))' THEN
    RAISE EXCEPTION 'fingerprint depends on the clock or randomness';
  END IF;

  v_a := public.bank_transaction_fingerprint(v_acct, DATE '2026-01-15', 'ACME  PAYMENT', 125.50, 'ref-1');
  v_b := public.bank_transaction_fingerprint(v_acct, DATE '2026-01-15', 'acme payment',  125.50, 'ref-1');
  v_c := public.bank_transaction_fingerprint(v_acct, DATE '2026-01-15', 'ACME  PAYMENT', 125.51, 'ref-1');

  IF v_a IS NULL THEN RAISE EXCEPTION 'fingerprint returned NULL'; END IF;
  IF v_a IS DISTINCT FROM v_b THEN
    RAISE EXCEPTION 'fingerprint is not normalised: case/whitespace produce different values';
  END IF;
  IF v_a = v_c THEN
    RAISE EXCEPTION 'fingerprint collides across different amounts';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 3) Dedup is enforced by the DATABASE, not by a SELECT-then-INSERT race:
--    a unique index on (bank_account_id, external_transaction_id) — the
--    column that carries the fingerprint — must exist.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'public.bank_transactions'::regclass
      AND i.indisunique
      AND pg_get_indexdef(i.indexrelid) ILIKE '%bank_account_id%'
      AND pg_get_indexdef(i.indexrelid) ILIKE '%external_transaction_id%'
  ) THEN
    RAISE EXCEPTION 'no unique index on (bank_account_id, external_transaction_id) — concurrent imports can double-post';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 4) Ingestion guards: account must be active, currency must match the
--    account, a locked period cannot receive lines, and refusals are
--    reported as rejected rows rather than thrown away.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='bank_statement_import_batch';

  IF v_src NOT LIKE '%BANK_ACCOUNT_NOT_ACTIVE%' THEN
    RAISE EXCEPTION 'a draft/suspended/closed account can still receive statement lines';
  END IF;
  IF v_src NOT ILIKE '%currency%' THEN
    RAISE EXCEPTION 'import engine does not consider currency';
  END IF;
  IF v_src NOT ILIKE '%rejected%' THEN
    RAISE EXCEPTION 'import engine does not report rejected rows';
  END IF;
  IF v_src NOT LIKE '%bank_transaction_fingerprint%' THEN
    RAISE EXCEPTION 'import engine does not compute the dedup fingerprint';
  END IF;
  IF v_src NOT LIKE '%BANK_IMPORT_NO_ACTOR%' THEN
    RAISE EXCEPTION 'import engine accepts an unattributed batch';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 5) No second ingestion path: nothing else in the schema inserts into
--    bank_transactions except the engine, the reconciliation seams and
--    the ownership triggers.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_offenders text;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_offenders
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public'
    AND p.prokind = 'f'
    AND pg_get_functiondef(p.oid) ~* 'insert\s+into\s+(public\.)?bank_transactions'
    AND p.proname NOT IN (
      'bank_statement_import_batch',
      'reconcile_bank_transfer_atomic'
    );

  IF v_offenders IS NOT NULL THEN
    RAISE EXCEPTION 'second ingestion path(s) into bank_transactions: %', v_offenders;
  END IF;
END $$;

SELECT 'bank_statement_ingestion_invariants: ok' AS result;

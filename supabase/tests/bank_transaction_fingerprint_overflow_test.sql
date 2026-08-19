-- =====================================================================
-- Banking · bank_transaction_fingerprint must never raise 22003
--
-- WHY THIS EXISTS
-- The fingerprint is a hand-rolled FNV hash. It originally reduced modulo
-- 2^32 *after* the multiply:
--
--   h2 := ((h2 # c) * 2166136261) % 4294967296
--
-- h2 can reach 4294967295 and 4294967295 * 2166136261 = 9.30e18, which is
-- past the bigint ceiling (9.22e18). Postgres raised
-- `22003 bigint out of range` before the modulo ever ran, so roughly 0.9%
-- of characters aborted the whole statement import. Over a ~120 character
-- fingerprint string that is a majority of real bank statements.
--
-- The multiply now happens in numeric, so the value is unchanged and the
-- overflow is impossible. These assertions pin both properties.
--
-- Run with: supabase test db --linked --file bank_transaction_fingerprint_overflow_test.sql
-- =====================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- 1) The multiply is done in a wider type — no bare bigint product.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'bank_transaction_fingerprint';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'bank_transaction_fingerprint is missing';
  END IF;

  IF v_src ~ '\(h[12]\s*#\s*u\)\s*\*' THEN
    RAISE EXCEPTION 'fingerprint still multiplies in bigint — 22003 can recur';
  END IF;

  IF v_src !~ '::numeric\s*\*' THEN
    RAISE EXCEPTION 'fingerprint does not widen the multiply to numeric';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2) Adversarial inputs must produce a fingerprint, not an exception.
--    The first vector is the exact string that reproduced the user's
--    22003 (it drives h2 into the overflow band mid-string).
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_desc text;
  v_fp   text;
BEGIN
  FOREACH v_desc IN ARRAY ARRAY[
    'ACME SUPPLIES LTD PAYMENT REF 99321 BRANCH WESTLANDS',
    '',
    repeat('X', 4000),
    'Café Zürich — naïve payée',
    'emoji 😀 in description',
    E'tab\tand newline\nrow',
    'MPESA/QR/12345678901234567890/PAY BILL'
  ] LOOP
    v_fp := public.bank_transaction_fingerprint(
      'cf817a72-e0e6-43ff-b6e0-e080db9acaaf'::uuid,
      DATE '2026-01-15',
      v_desc,
      15234.75,
      'REF-889231');

    IF v_fp !~ '^imp_[0-9a-f]{16}$' THEN
      RAISE EXCEPTION 'fingerprint shape wrong for %: %', left(v_desc, 30), v_fp;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 3) Cross-implementation vector. The browser's generateTransactionHash
--    (src/lib/bankStatementParsers/index.ts) must produce this exact value
--    for the same inputs — the preview duplicate count is meaningless if
--    the two hashes drift. The same vector is pinned in csvParser.test.ts.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_fp text;
BEGIN
  v_fp := public.bank_transaction_fingerprint(
    'cf817a72-e0e6-43ff-b6e0-e080db9acaaf'::uuid,
    DATE '2026-01-15',
    'ACME SUPPLIES LTD PAYMENT REF 99321 BRANCH WESTLANDS',
    15234.75,
    'REF-889231');

  IF v_fp <> 'imp_aa29bd90a544fc70' THEN
    RAISE EXCEPTION 'fingerprint drifted from the pinned JS vector: %', v_fp;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 4) Determinism: same inputs, same fingerprint (dedupe depends on it).
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF public.bank_transaction_fingerprint(
       'cf817a72-e0e6-43ff-b6e0-e080db9acaaf'::uuid, DATE '2026-01-15', 'Repeat me', -50.5, 'R1')
     <> public.bank_transaction_fingerprint(
       'cf817a72-e0e6-43ff-b6e0-e080db9acaaf'::uuid, DATE '2026-01-15', 'Repeat me', -50.5, 'R1') THEN
    RAISE EXCEPTION 'fingerprint is not deterministic';
  END IF;
END $$;

SELECT 'bank_transaction_fingerprint_overflow: ok' AS result;

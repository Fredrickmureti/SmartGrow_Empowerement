-- ADR 0136 — one FX engine.
--
-- Read-only catalogue invariants. This suite executes no DML: it inspects
-- pg_proc / pg_get_functiondef only, so it is safe to run anywhere.
--
-- It ratchets the Phase 8 convergence:
--   1. `_pick_exchange_rate_row` is the ONLY public function that reads
--      `public.exchange_rates`; writes are confined to the two governed
--      mutators (`set_exchange_rate_override`, `publish_platform_rates`).
--   2. The conversion helpers carry no silent 1:1 parity fallback.
--   3. `to_base_amount` / `describe_exchange_rate` delegate to the resolver
--      chain instead of re-implementing precedence.
--   4. None of the FX helpers is executable by `anon` or `PUBLIC`, and the
--      internal picker is not executable by `authenticated` either.

BEGIN;

DO $$
DECLARE
  v_offenders text;
  v_def       text;
  v_acl       text;
  v_fn        text;
BEGIN
  -- 1a. Only the picker may READ the rate book.
  SELECT string_agg(fn, ', ' ORDER BY fn) INTO v_offenders
  FROM (
    SELECT p.oid::regprocedure::text AS fn
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND pg_get_functiondef(p.oid) ~* '(from|join)\s+(public\.)?exchange_rates\M'
      AND p.proname <> '_pick_exchange_rate_row'
  ) s;
  IF v_offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'ADR 0136: these functions read public.exchange_rates directly instead of _pick_exchange_rate_row: %',
      v_offenders;
  END IF;

  -- 1b. The picker itself must still exist and read the book.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = '_pick_exchange_rate_row'
      AND pg_get_functiondef(p.oid) ~* '(from|join)\s+(public\.)?exchange_rates\M'
  ) THEN
    RAISE EXCEPTION 'ADR 0136: _pick_exchange_rate_row is missing or no longer reads the rate book';
  END IF;

  -- 1c. Writes to the rate book stay with the governed mutators.
  SELECT string_agg(fn, ', ' ORDER BY fn) INTO v_offenders
  FROM (
    SELECT p.oid::regprocedure::text AS fn
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND pg_get_functiondef(p.oid) ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?exchange_rates\M'
      AND p.proname NOT IN ('set_exchange_rate_override', 'publish_platform_rates')
  ) s;
  IF v_offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'ADR 0136: unexpected writers of public.exchange_rates: %', v_offenders;
  END IF;

  -- 2/3. Conversion helpers: no parity fallback, and delegation in place.
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'to_base_amount'
  LIMIT 1;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'public.to_base_amount is missing';
  END IF;
  IF v_def !~* 'resolve_exchange_rate' THEN
    RAISE EXCEPTION 'to_base_amount no longer resolves through resolve_exchange_rate';
  END IF;
  IF v_def ~* 'else\s+_amount' OR v_def ~* 'coalesce\s*\([^;]*,\s*1\s*\)' THEN
    RAISE EXCEPTION 'to_base_amount reintroduced a silent 1:1 parity fallback';
  END IF;
  IF v_def !~* 'user_can_access_business' THEN
    RAISE EXCEPTION 'to_base_amount lost its business-access gate';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'describe_exchange_rate'
  LIMIT 1;
  IF v_def IS NULL OR v_def !~* '_pick_exchange_rate_row' THEN
    RAISE EXCEPTION 'describe_exchange_rate must delegate to _pick_exchange_rate_row';
  END IF;
  IF v_def !~* 'user_can_access_business' THEN
    RAISE EXCEPTION 'describe_exchange_rate lost its business-access gate';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'resolve_exchange_rate'
  LIMIT 1;
  IF v_def IS NULL OR v_def !~* '_pick_exchange_rate_row' THEN
    RAISE EXCEPTION 'resolve_exchange_rate must delegate to _pick_exchange_rate_row';
  END IF;
  IF v_def ~* 'coalesce\s*\([^;]*,\s*1\s*\)' THEN
    RAISE EXCEPTION 'resolve_exchange_rate reintroduced a 1:1 fallback';
  END IF;

  -- 3b. 3PL billing must not resolve its own rate.
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = '_wms_generate_3pl_invoice_internal'
  LIMIT 1;
  IF v_def IS NOT NULL AND v_def !~* 'require_exchange_rate' THEN
    RAISE EXCEPTION '_wms_generate_3pl_invoice_internal must bill through require_exchange_rate';
  END IF;

  -- 4. Execute surface.
  FOR v_fn, v_acl IN
    SELECT p.oid::regprocedure::text, coalesce(p.proacl::text, '')
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('to_base_amount', 'resolve_exchange_rate',
                        'require_exchange_rate', 'describe_exchange_rate',
                        '_pick_exchange_rate_row')
  LOOP
    IF v_acl = '' THEN
      RAISE EXCEPTION 'FX helper % has default (PUBLIC) EXECUTE — revoke it explicitly', v_fn;
    END IF;
    IF v_acl ~ '(^|,|\{)=X' THEN
      RAISE EXCEPTION 'FX helper % is executable by PUBLIC', v_fn;
    END IF;
    IF v_acl ~ 'anon=' THEN
      RAISE EXCEPTION 'FX helper % is executable by anon', v_fn;
    END IF;
    IF v_fn LIKE '_pick_exchange_rate_row%' AND v_acl ~ 'authenticated=' THEN
      RAISE EXCEPTION 'the internal picker % must not be callable by authenticated', v_fn;
    END IF;
  END LOOP;
END $$;

ROLLBACK;
